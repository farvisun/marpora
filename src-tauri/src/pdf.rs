//! PDF export and printing on macOS, as Typora does them there: the export page loads
//! in an offscreen WKWebView, which NSPrintOperation prints, either to a PDF file or
//! through the print panel.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::path::{Path, PathBuf};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send, sel};
use objc2_app_kit::{
    NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode,
    NSView, NSWindow,
};
use objc2_foundation::{NSCopying, NSError, NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_web_kit::{WKNavigation, WKNavigationDelegate, WKWebView, WKWebViewConfiguration};

/// Points per millimetre.
const MM: f64 = 72.0 / 25.4;

/// Typora's defaults: A4, with 16mm margins.
const PAPER: (f64, f64) = (210.0 * MM, 297.0 * MM);
const MARGIN: f64 = 16.0 * MM;

/// WebKit takes the page box from CSS, not from the print info, so the paper and
/// margins go into the page as Typora's Mac build puts them.
pub fn page_css() -> String {
    format!(
        "@media print {{ * {{ -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }} \
         @page {{ size: {w:.2}pt {h:.2}pt; margin-top: {m:.2}pt !important; margin-right: {m:.2}pt !important; \
         margin-bottom: {m:.2}pt !important; margin-left: {m:.2}pt !important; }} \
         html, body {{ margin: 0 !important; padding: 0 !important; -webkit-print-color-adjust: exact !important; \
         print-color-adjust: exact !important; }} }}",
        w = PAPER.0,
        h = PAPER.1,
        m = MARGIN,
    )
}

pub enum Output {
    /// Save as a PDF file.
    Pdf(PathBuf),
    /// Show the print panel.
    Printer,
}

type Done = Box<dyn FnOnce(Result<(), String>)>;

pub struct JobIvars {
    window: Retained<NSWindow>,
    web: RefCell<Option<Retained<WKWebView>>>,
    output: Output,
    done: Cell<Option<Done>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and PrintJob does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MarporaPrintJob"]
    #[ivars = JobIvars]
    pub struct PrintJob;

    unsafe impl NSObjectProtocol for PrintJob {}

    unsafe impl WKNavigationDelegate for PrintJob {
        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
            self.print(web);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _web: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            self.finish(Err(error.localizedDescription().to_string()));
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, _web: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            self.finish(Err(error.localizedDescription().to_string()));
        }
    }

    impl PrintJob {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _operation: &NSPrintOperation, success: bool, _context: *mut c_void) {
            // Cancelling the print panel is not an error.
            let printer = matches!(self.ivars().output, Output::Printer);
            self.finish(if success || printer { Ok(()) } else { Err("printing failed".into()) });
        }
    }
);

thread_local! {
    /// Jobs in flight; the web view only holds its navigation delegate weakly.
    static JOBS: RefCell<Vec<Retained<PrintJob>>> = const { RefCell::new(Vec::new()) };
}

impl PrintJob {
    fn print(&self, web: &WKWebView) {
        let ivars = self.ivars();
        // SAFETY: plain property setters on objects created here, on the main thread.
        unsafe {
            let info = NSPrintInfo::sharedPrintInfo().copy();
            info.setPaperSize(NSSize::new(PAPER.0, PAPER.1));
            // The page's `@page` rule sets the margins (see `page_css`).
            info.setTopMargin(0.0);
            info.setBottomMargin(0.0);
            info.setLeftMargin(0.0);
            info.setRightMargin(0.0);
            info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
            info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
            info.setHorizontallyCentered(false);
            info.setVerticallyCentered(false);
            if let Output::Pdf(path) = &ivars.output {
                info.setJobDisposition(NSPrintSaveJob);
                let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                info.dictionary()
                    .setObject_forKey(&url, ProtocolObject::from_ref(NSPrintJobSavingURL));
            }
            let operation = web.printOperationWithPrintInfo(&info);
            let panel = matches!(ivars.output, Output::Printer);
            operation.setShowsPrintPanel(panel);
            operation.setShowsProgressPanel(panel);
            // The print view starts with an empty frame and would print blank pages.
            if let Some(view) = operation.view() {
                view.setFrame(web.frame());
            }
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &ivars.window,
                Some(self as &AnyObject),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
    }

    fn finish(&self, result: Result<(), String>) {
        let ivars = self.ivars();
        if let Some(web) = ivars.web.take() {
            web.removeFromSuperview();
        }
        if let Some(done) = ivars.done.take() {
            done(result);
        }
        JOBS.with(|jobs| jobs.borrow_mut().retain(|j| !std::ptr::eq(&**j, self)));
    }
}

/// Print the page in `html_file` (which may load any local file) as `output`. Runs on
/// the main thread; `done` is called when the job ends.
pub fn print(window: &NSWindow, html_file: &Path, output: Output, done: Done) {
    let Some(mtm) = MainThreadMarker::new() else {
        return done(Err("printing must start on the main thread".into()));
    };
    let Some(content) = window.contentView() else {
        return done(Err("the window has no content view".into()));
    };
    // SAFETY: WebKit objects are created and used on the main thread only.
    unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        // Offscreen but inside a window, which WebKit needs to lay the page out.
        let frame = NSRect::new(NSPoint::new(-20000.0, 0.0), NSSize::new(800.0, 1000.0));
        let web = WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config);
        content.addSubview(&web as &NSView);

        let job = PrintJob::alloc(mtm).set_ivars(JobIvars {
            window: window.retain(),
            web: RefCell::new(Some(web.clone())),
            output,
            done: Cell::new(Some(done)),
        });
        let job: Retained<PrintJob> = msg_send![super(job), init];
        web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*job)));
        JOBS.with(|jobs| jobs.borrow_mut().push(job));

        let page = NSURL::fileURLWithPath(&NSString::from_str(&html_file.to_string_lossy()));
        let root = NSURL::fileURLWithPath(&NSString::from_str("/"));
        web.loadFileURL_allowingReadAccessToURL(&page, &root);
    }
}
