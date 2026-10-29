//! The editor's context menu, as Typora has it on the Mac: WebKit's own menu (Look Up,
//! Cut, Copy, Paste, Spelling, Services, …) with Typora's items added: Copy / Paste As,
//! Format, Paragraph, Insert, the table's and the block's items, and Open Link on links.
//!
//! The web view says what was clicked (`set_context_menu`) on the right mouse down and
//! again on `contextmenu`; WebKit then asks the view to adjust its menu in
//! `willOpenMenu:withEvent:`, which wry's web view class does not implement, so it is
//! added here. Should the context come after the menu opened, the open menu is redone.
//! The items send their menu ids to the window, as the main menu's do.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, NSObject, Sel};
use objc2::{MainThreadOnly, define_class, ffi, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSControlStateValueOn, NSEvent, NSMenu, NSMenuItem,
    NSUserInterfaceItemIdentification, NSView,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSString};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// What the right click was on, from the web view.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    /// In the editor's text; elsewhere WebKit's menu shows unchanged.
    #[serde(default)]
    editor: bool,
    #[serde(default)]
    link: bool,
    #[serde(default)]
    table: bool,
    /// The block clicked when it is a code block, math block or HTML block.
    #[serde(default)]
    block: Option<String>,
    /// Menu ids of the styles at the cursor, which show checked.
    #[serde(default)]
    active: Vec<String>,
}

enum Entry {
    /// Menu id, title, and the main menu holding the item whose shortcut it shows.
    Item(&'static str, &'static str, &'static str),
    Sub(&'static str, &'static [Entry]),
    Separator,
}

use Entry::{Item, Separator, Sub};

const COPY_AS: &[Entry] = &[
    Item("copy-markdown", "Copy as Markdown", "Edit"),
    Item("copy-html", "Copy as HTML Code", "Edit"),
    Item("copy-no-style", "Copy without Theme Styling", "Edit"),
    Item("copy-plain", "Copy as Plain Text", "Edit"),
    Separator,
    Item("paste-plain", "Paste as Plain Text", "Edit"),
];

const FORMAT: &[Entry] = &[
    Item("strong", "Strong", "Format"),
    Item("em", "Emphasis", "Format"),
    Item("underline", "Underline", "Format"),
    Item("code", "Code", "Format"),
    Item("strike", "Strike", "Format"),
    Item("highlight", "Highlight", "Format"),
    Item("link", "Hyperlink", "Format"),
    Separator,
    Item("clear-format", "Clear Format", "Format"),
];

const PARAGRAPH: &[Entry] = &[
    Item("heading-1", "Heading 1", "Paragraph"),
    Item("heading-2", "Heading 2", "Paragraph"),
    Item("heading-3", "Heading 3", "Paragraph"),
    Item("heading-4", "Heading 4", "Paragraph"),
    Item("heading-5", "Heading 5", "Paragraph"),
    Item("heading-6", "Heading 6", "Paragraph"),
    Separator,
    Item("paragraph", "Paragraph", "Paragraph"),
    Separator,
    Item("quote", "Quote", "Paragraph"),
    Item("ordered-list", "Ordered List", "Paragraph"),
    Item("bullet-list", "Unordered List", "Paragraph"),
    Item("task-list", "Task List", "Paragraph"),
];

const INSERT: &[Entry] = &[
    Item("insert-image", "Image", "Format"),
    Separator,
    Item("footnote", "Footnotes", "Paragraph"),
    Item("link-reference", "Link Reference", "Paragraph"),
    Item("hr", "Horizontal Line", "Paragraph"),
    Item("table", "Table", "Paragraph"),
    Item("code-fence", "Code Fences", "Paragraph"),
    Item("math-block", "Math Block", "Paragraph"),
    Item("toc", "Table of Contents", "Paragraph"),
    Item("front-matter", "YAML Front Matter", "Paragraph"),
];

const TABLE: &[Entry] = &[
    Item("table-row-above", "Add Row Above", "Paragraph"),
    Item("table-row-below", "Add Row Below", "Paragraph"),
    Item("table-col-before", "Add Column Before", "Paragraph"),
    Item("table-col-after", "Add Column After", "Paragraph"),
    Separator,
    Item("table-delete-row", "Delete Row", "Paragraph"),
    Item("table-delete-col", "Delete Column", "Paragraph"),
    Separator,
    Item("table-copy", "Copy Table", "Paragraph"),
    Separator,
    Item("table-delete", "Delete Table", "Paragraph"),
];

/// The items for `cx`: those before WebKit's, and those after its Cut, Copy and Paste.
fn entries(cx: &Context) -> (Vec<Entry>, Vec<Entry>) {
    let mut before = Vec::new();
    if cx.link {
        before.extend([
            Item("open-link", "Open Link", "Format"),
            Item("copy-link", "Copy Link Address", "Format"),
            Separator,
        ]);
    }
    let mut after = vec![
        Sub("Copy / Paste As", COPY_AS),
        Separator,
        Sub("Format", FORMAT),
        Sub("Paragraph", PARAGRAPH),
        Sub("Insert", INSERT),
    ];
    if cx.table {
        after.push(Sub("Table", TABLE));
    }
    after.extend([
        Separator,
        Item("paragraph-before", "Insert Paragraph Before", "Paragraph"),
        Item("paragraph-after", "Insert Paragraph After", "Paragraph"),
    ]);
    match cx.block.as_deref() {
        Some("code") => after.extend([
            Separator,
            Item("copy-code", "Copy Code Content", "Paragraph"),
            Item("delete-block", "Delete Code Block", "Edit"),
        ]),
        Some(_) => after.push(Item("delete-block", "Delete", "Edit")),
        None => {}
    }
    (before, after)
}

/// Tags our items carry, to find and replace them in an open menu.
const TAG: isize = 0x6d61_7270;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// The last context each window sent.
static CONTEXTS: Mutex<Option<HashMap<String, Context>>> = Mutex::new(None);

thread_local! {
    static TARGET: RefCell<Option<Retained<Target>>> = const { RefCell::new(None) };
    /// The menu last opened, and the window it is for.
    static OPEN: RefCell<Option<(String, Retained<NSMenu>)>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MarporaContextMenuTarget"]
    struct Target;

    impl Target {
        #[unsafe(method(run:))]
        fn run(&self, item: &NSMenuItem) {
            let Some(id) = item.representedObject() else { return };
            // SAFETY: our items hold their menu id as an NSString.
            let id = unsafe { &*(Retained::as_ptr(&id) as *const NSString) }.to_string();
            let label = OPEN.with_borrow(|open| open.as_ref().map(|(label, _)| label.clone()));
            if let (Some(app), Some(label)) = (APP.get(), label) {
                let _ = app.emit_to(&label, "menu", id);
            }
        }
    }

    unsafe impl NSObjectProtocol for Target {}
);

fn target(mtm: MainThreadMarker) -> Retained<Target> {
    TARGET.with_borrow_mut(|t| {
        t.get_or_insert_with(|| {
            let this = Target::alloc(mtm).set_ivars(());
            // SAFETY: NSObject's init.
            unsafe { msg_send![super(this), init] }
        })
        .clone()
    })
}

/// Add `willOpenMenu:withEvent:` to wry's web view class, the one under WKWebView in
/// `window`'s web view's class chain (wry names it after its module and version).
pub fn install(window: &WebviewWindow) {
    let _ = APP.set(window.app_handle().clone());
    if INSTALLED.load(Ordering::Acquire) {
        return;
    }
    let _ = window.with_webview(|webview| {
        // SAFETY: `inner` is the window's live WKWebView; this runs on the main thread.
        add_method(unsafe { &*(webview.inner() as *const AnyObject) });
    });
}

static INSTALLED: AtomicBool = AtomicBool::new(false);

fn add_method(webview: &AnyObject) {
    let Some(wk) = AnyClass::get(c"WKWebView") else {
        return;
    };
    let mut class = webview.class();
    while let Some(superclass) = class.superclass() {
        if superclass == wk {
            break;
        }
        class = superclass;
    }
    if class.superclass() != Some(wk) || INSTALLED.swap(true, Ordering::AcqRel) {
        return;
    }
    let imp: unsafe extern "C-unwind" fn(&NSView, Sel, &NSMenu, Option<&NSEvent>) = will_open_menu;
    // SAFETY: the function takes what "v@:@@" says: the view, the selector, the menu
    // and the event, and returns nothing. WKWebView's own is called from it.
    let added = unsafe {
        ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(willOpenMenu:withEvent:),
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(&NSView, Sel, &NSMenu, Option<&NSEvent>),
                Imp,
            >(imp),
            c"v@:@@".as_ptr(),
        )
    };
    #[cfg(debug_assertions)]
    if std::env::var_os("MARPORA_CONTEXT_PROBE").is_some() {
        eprintln!("CONTEXT HOOK {} {:?}", added.as_bool(), class.name());
    }
    let _ = added;
}

unsafe extern "C-unwind" fn will_open_menu(
    this: &NSView,
    cmd: Sel,
    menu: &NSMenu,
    event: Option<&NSEvent>,
) {
    // WKWebView builds its menu here; ours goes on top.
    if let Some(class) = AnyClass::get(c"WKWebView") {
        // SAFETY: the superclass's method of the same signature, on the same view.
        unsafe {
            let _: () = msg_send![super(this, class), willOpenMenu: menu, withEvent: event];
        }
    }
    let _ = cmd;
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(label) = label_of(this) else { return };
    let cx = context(&label);
    // SAFETY: `menu` is alive for this call; retaining it keeps it for a late context.
    let menu: Retained<NSMenu> =
        unsafe { Retained::retain(menu as *const NSMenu as *mut NSMenu) }.expect("menu");
    tidy_webkit_items(&menu);
    fill(mtm, &menu, &cx);
    OPEN.with_borrow_mut(|open| *open = Some((label, menu)));
}

/// The label of the window showing `view`.
fn label_of(view: &NSView) -> Option<String> {
    let app = APP.get()?;
    let window = view.window()?;
    let ptr = Retained::as_ptr(&window) as *mut std::ffi::c_void;
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.ns_window().is_ok_and(|ns| ns == ptr))
        .map(|(label, _)| label)
}

fn context(label: &str) -> Context {
    let contexts = CONTEXTS.lock().unwrap_or_else(|e| e.into_inner());
    contexts
        .as_ref()
        .and_then(|c| c.get(label))
        .cloned()
        .unwrap_or_default()
}

/// Record what was clicked in `label`'s window, redoing its menu if it is open.
pub fn set(app: &AppHandle, label: &str, cx: Context) {
    if let Some(window) = app.get_webview_window(label) {
        install(&window);
    }
    CONTEXTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(label.to_owned(), cx.clone());
    let owned = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let open = OPEN.with_borrow(|open| {
            open.as_ref()
                .filter(|(l, _)| *l == owned)
                .map(|(_, menu)| menu.clone())
        });
        if let Some(menu) = open {
            fill(mtm, &menu, &cx);
        }
    });
    #[cfg(debug_assertions)]
    if let (Some(_), Some(window)) = (
        std::env::var_os("MARPORA_CONTEXT_PROBE"),
        app.get_webview_window(label),
    ) {
        let _ = window.with_webview(|webview| {
            // SAFETY: the window's live WKWebView, on the main thread.
            let view = unsafe { &*(webview.inner() as *const NSView) };
            eprintln!("CONTEXT {}", preview(view).join(" | "));
        });
    }
}

/// WebKit's items that would act in the web view: its link and image items (which
/// open pages inside the window) and the page's Reload, Back and Forward.
fn tidy_webkit_items(menu: &NSMenu) {
    const DROP: &[&str] = &[
        "OpenLink",
        "DownloadLinkedFile",
        "CopyLink",
        "OpenImageInNewWindow",
        "DownloadImage",
        "OpenFrameInNewWindow",
        "Reload",
        "GoBack",
        "GoForward",
    ];
    for i in (0..menu.numberOfItems()).rev() {
        let Some(item) = menu.itemAtIndex(i) else {
            continue;
        };
        let id = item.identifier().map(|s| s.to_string()).unwrap_or_default();
        if DROP.iter().any(|d| id.contains(d)) {
            menu.removeItemAtIndex(i);
        }
    }
}

/// Put our items for `cx` into `menu`, replacing any there.
fn fill(mtm: MainThreadMarker, menu: &NSMenu, cx: &Context) {
    for i in (0..menu.numberOfItems()).rev() {
        if menu.itemAtIndex(i).is_some_and(|item| item.tag() == TAG) {
            menu.removeItemAtIndex(i);
        }
    }
    if cx.editor {
        let (before, after) = entries(cx);
        for (at, entry) in (0..).zip(&before) {
            menu.insertItem_atIndex(&make(mtm, entry, cx), at);
        }
        // After WebKit's Paste, else at the end.
        let paste = (0..menu.numberOfItems()).find(|&i| {
            menu.itemAtIndex(i).is_some_and(|item| {
                let id = item.identifier().map(|s| s.to_string()).unwrap_or_default();
                id.ends_with("Paste") || item.title().to_string() == "Paste"
            })
        });
        let start = paste.map_or(menu.numberOfItems(), |i| i + 1);
        let items = std::iter::once(Separator).chain(after);
        for (at, entry) in (start..).zip(items) {
            menu.insertItem_atIndex(&make(mtm, &entry, cx), at);
        }
    }
    tidy_separators(menu);
}

/// No separator first, last, or after another.
fn tidy_separators(menu: &NSMenu) {
    let mut previous_separator = true;
    let mut i = 0;
    while i < menu.numberOfItems() {
        let Some(item) = menu.itemAtIndex(i) else {
            break;
        };
        let separator = item.isSeparatorItem();
        if separator && previous_separator {
            menu.removeItemAtIndex(i);
            continue;
        }
        previous_separator = separator;
        i += 1;
    }
    let n = menu.numberOfItems();
    if n > 0
        && menu
            .itemAtIndex(n - 1)
            .is_some_and(|item| item.isSeparatorItem())
    {
        menu.removeItemAtIndex(n - 1);
    }
}

fn make(mtm: MainThreadMarker, entry: &Entry, cx: &Context) -> Retained<NSMenuItem> {
    let item = match entry {
        Separator => NSMenuItem::separatorItem(mtm),
        Item(id, title, top) => {
            let item = NSMenuItem::new(mtm);
            item.setTitle(&NSString::from_str(title));
            // SAFETY: `run:` takes the sender, and the target is kept for the app's life.
            unsafe {
                item.setTarget(Some(&target(mtm)));
                item.setAction(Some(sel!(run:)));
                item.setRepresentedObject(Some(&NSString::from_str(id)));
            }
            // The main menu's own titles where they differ.
            let main_title = match *id {
                "insert-image" => "Insert Image",
                "table" => "Insert Table",
                _ => title,
            };
            if let Some(main) = main_item(mtm, top, main_title) {
                item.setKeyEquivalent(&main.keyEquivalent());
                item.setKeyEquivalentModifierMask(main.keyEquivalentModifierMask());
            }
            if cx.active.iter().any(|a| a == id) {
                item.setState(NSControlStateValueOn);
            }
            item
        }
        Sub(title, entries) => {
            let item = NSMenuItem::new(mtm);
            item.setTitle(&NSString::from_str(title));
            let sub = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
            for e in entries.iter() {
                sub.addItem(&make(mtm, e, cx));
            }
            item.setSubmenu(Some(&sub));
            item
        }
    };
    item.setTag(TAG);
    item
}

/// The item titled `title` anywhere in the main menu's `top` menu, for its shortcut.
fn main_item(mtm: MainThreadMarker, top: &str, title: &str) -> Option<Retained<NSMenuItem>> {
    fn find(menu: &NSMenu, title: &NSString) -> Option<Retained<NSMenuItem>> {
        for i in 0..menu.numberOfItems() {
            let item = menu.itemAtIndex(i)?;
            if item.title().isEqualToString(title) && !item.keyEquivalent().is_empty() {
                return Some(item);
            }
            if let Some(found) = item.submenu().and_then(|sub| find(&sub, title)) {
                return Some(found);
            }
        }
        None
    }
    let menu = NSApplication::sharedApplication(mtm)
        .mainMenu()?
        .itemWithTitle(&NSString::from_str(top))?
        .submenu()?;
    find(&menu, &NSString::from_str(title))
}

/// The titles of `menu`'s items, submenus indented, for checks in debug builds.
#[cfg(debug_assertions)]
pub fn describe(menu: &NSMenu, depth: usize, out: &mut Vec<String>) {
    for i in 0..menu.numberOfItems() {
        let Some(item) = menu.itemAtIndex(i) else {
            continue;
        };
        let pad = "  ".repeat(depth);
        if item.isSeparatorItem() {
            out.push(format!("{pad}-"));
            continue;
        }
        let key = item.keyEquivalent().to_string();
        let on = if item.state() == NSControlStateValueOn {
            " ✓"
        } else {
            ""
        };
        out.push(format!(
            "{pad}{}{on}{}",
            item.title(),
            if key.is_empty() {
                String::new()
            } else {
                format!(" [{key}]")
            }
        ));
        if let Some(sub) = item.submenu() {
            describe(&sub, depth + 1, out);
        }
    }
}

/// The menu `view` makes of a stand-in for WebKit's, as text (debug builds).
#[cfg(debug_assertions)]
fn preview(view: &NSView) -> Vec<String> {
    let mtm = MainThreadMarker::new().expect("main thread");
    let menu = NSMenu::new(mtm);
    for title in ["Look Up", "-", "Cut", "Copy", "Paste", "-", "Services"] {
        if title == "-" {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        } else {
            let item = NSMenuItem::new(mtm);
            item.setTitle(&NSString::from_str(title));
            menu.addItem(&item);
        }
    }
    // SAFETY: the method added above, with a menu and no event.
    unsafe {
        let _: () = msg_send![view, willOpenMenu: &*menu, withEvent: Option::<&NSEvent>::None];
    }
    let mut out = Vec::new();
    describe(&menu, 0, &mut out);
    out
}
