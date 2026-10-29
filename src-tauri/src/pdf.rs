//! PDF and image export and printing on macOS, as Typora does them there: the export
//! page loads in an offscreen WKWebView, which NSPrintOperation prints, either to a PDF
//! file or through the print panel, or which is snapshotted whole into a PNG file.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::path::{Path, PathBuf};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send, sel,
};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    NSPageLayout, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
    NSPrintingPaginationMode, NSView, NSWindow,
};
use objc2_foundation::{
    NSCopying, NSData, NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize, NSString, NSURL,
};
use objc2_web_kit::{
    WKNavigation, WKNavigationDelegate, WKPDFConfiguration, WKWebView, WKWebViewConfiguration,
};

/// Points per millimetre.
const MM: f64 = 72.0 / 25.4;

/// Typora's defaults: A4, with 16mm margins.
const PAPER: (f64, f64) = (210.0 * MM, 297.0 * MM);
pub const MARGIN: f64 = 16.0 * MM;

/// File › Page Setup's paper for printing, in points, once the user has chosen one.
static PRINT_PAPER: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);

/// The paper for `output`: Page Setup's for printing, else A4.
pub fn paper_for(printing: bool) -> (f64, f64) {
    let chosen = *PRINT_PAPER.lock().unwrap_or_else(|e| e.into_inner());
    chosen.filter(|_| printing).unwrap_or(PAPER)
}

/// File › Page Setup…: the system's page layout panel, whose paper Print then uses.
pub fn page_setup() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let info = NSPrintInfo::sharedPrintInfo();
    let mut chosen = PRINT_PAPER.lock().unwrap_or_else(|e| e.into_inner());
    if chosen.is_none() {
        info.setPaperSize(NSSize::new(PAPER.0, PAPER.1));
    }
    // NSModalResponseOK
    if NSPageLayout::pageLayout(mtm).runModalWithPrintInfo(&info) == 1 {
        let size = info.paperSize();
        *chosen = Some((size.width, size.height));
    }
}

/// WebKit takes the page box from CSS, not from the print info, so the paper and
/// margins go into the page as Typora's Mac build puts them.
pub fn page_css(paper: (f64, f64), margin: f64) -> String {
    format!(
        "@media print {{ * {{ -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }} \
         @page {{ size: {w:.2}pt {h:.2}pt; margin-top: {m:.2}pt !important; margin-right: {m:.2}pt !important; \
         margin-bottom: {m:.2}pt !important; margin-left: {m:.2}pt !important; }} \
         html, body {{ margin: 0 !important; padding: 0 !important; -webkit-print-color-adjust: exact !important; \
         print-color-adjust: exact !important; }} }}",
        w = paper.0,
        h = paper.1,
        m = margin,
    )
}

pub enum Output {
    /// Save as a PDF file; on this paper (in points), without margins, for slides.
    Pdf(PathBuf, Option<(f64, f64)>),
    /// Show the print panel.
    Printer,
    /// Save the whole page, laid out this wide (Preferences › Export), as a PNG file.
    Png(PathBuf, f64),
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
            match self.ivars().output {
                Output::Png(..) => self.snapshot(web),
                _ => self.print(web),
            }
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
            let paper = match ivars.output {
                Output::Pdf(_, Some(slide)) => slide,
                ref o => paper_for(matches!(o, Output::Printer)),
            };
            info.setPaperSize(NSSize::new(paper.0, paper.1));
            // The page's `@page` rule sets the margins (see `page_css`).
            info.setTopMargin(0.0);
            info.setBottomMargin(0.0);
            info.setLeftMargin(0.0);
            info.setRightMargin(0.0);
            info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
            info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
            info.setHorizontallyCentered(false);
            info.setVerticallyCentered(false);
            if let Output::Pdf(path, _) = &ivars.output {
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

    /// Measure the page, grow the view to its height, and draw all of it into a PNG.
    /// WebKit only paints what an offscreen view would show of a window's height, so a
    /// snapshot comes out blank below that: the page is drawn as one PDF page instead,
    /// which is then rasterized at the screen's scale.
    fn snapshot(&self, web: &WKWebView) {
        let job = self.retain();
        let view = web.retain();
        let measured = RcBlock::new(move |height: *mut AnyObject, error: *mut NSError| {
            // SAFETY: WebKit passes an NSNumber for a number result, or an error.
            let height = unsafe { height.cast::<NSNumber>().as_ref() }.map(|n| n.doubleValue());
            let Some(height) = height.filter(|h| *h > 0.0) else {
                return job.failed(error, "could not measure the page");
            };
            let mut frame = view.frame();
            frame.size.height = height.ceil();
            view.setFrame(frame);
            // SAFETY: a new configuration and a plain property setter, on the main thread.
            let config = unsafe { WKPDFConfiguration::new(job.mtm()) };
            unsafe { config.setRect(NSRect::new(NSPoint::new(0.0, 0.0), frame.size)) };
            let scale = job.ivars().window.backingScaleFactor();
            let job = job.clone();
            let drawn = RcBlock::new(move |pdf: *mut NSData, error: *mut NSError| {
                // SAFETY: WebKit passes the PDF, or null and an error.
                match unsafe { pdf.as_ref() } {
                    Some(pdf) => job.finish(job.write_png(pdf, scale)),
                    None => job.failed(error, "could not draw the page"),
                }
            });
            // SAFETY: called on the main thread, from WebKit's own completion handler.
            unsafe { view.createPDFWithConfiguration_completionHandler(Some(&config), &drawn) };
        });
        // SAFETY: as above.
        unsafe {
            web.evaluateJavaScript_completionHandler(
                &NSString::from_str("document.documentElement.scrollHeight"),
                Some(&measured),
            );
        }
    }

    /// Rasterize the one-page `pdf` at `scale` pixels per point into the PNG file.
    fn write_png(&self, pdf: &NSData, scale: f64) -> Result<(), String> {
        let Output::Png(path, _) = &self.ivars().output else {
            return Err("not an image export".into());
        };
        let image =
            NSImage::initWithData(NSImage::alloc(), pdf).ok_or("could not read the page")?;
        let size = image.size();
        let pixels = |points: f64| (points * scale).round() as isize;
        // SAFETY: an RGBA bitmap that allocates its own memory (null planes, row and pixel
        // sizes worked out by AppKit).
        let bitmap = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                pixels(size.width),
                pixels(size.height),
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }
        .ok_or("the page is too large for an image")?;
        bitmap.setSize(size);
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)
            .ok_or("could not draw the image")?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));
        image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), size));
        NSGraphicsContext::restoreGraphicsState_class();
        // SAFETY: an empty property dictionary is valid for PNG.
        let png = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }
        .ok_or("could not encode the image")?;
        std::fs::write(path, png.to_vec())
            .map_err(|e| format!("could not write {}: {e}", path.display()))
    }

    fn failed(&self, error: *mut NSError, fallback: &str) {
        // SAFETY: WebKit's error argument is null or a valid NSError.
        let message = unsafe { error.as_ref() }
            .map(|e| e.localizedDescription().to_string())
            .unwrap_or_else(|| fallback.to_owned());
        self.finish(Err(message));
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

/// Print or snapshot the page in `html_file` (which may load any local file) as
/// `output`. Runs on the main thread; `done` is called when the job ends.
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
        let width = match output {
            Output::Png(_, width) => width,
            _ => 800.0,
        };
        let frame = NSRect::new(NSPoint::new(-20000.0, 0.0), NSSize::new(width, 1000.0));
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
