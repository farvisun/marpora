//! Document windows: one document per window, as in Typora on macOS.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use marpora_core::Document;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::docs::{Docs, OpenDoc};
use crate::library;
use crate::watch::Watcher;

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// Open `path` (or a new untitled document) in a window, reusing one that shows it.
pub fn open(app: &AppHandle, path: Option<PathBuf>) -> tauri::Result<()> {
    let docs = app.state::<Docs>();
    let path = path.map(|p| std::fs::canonicalize(&p).unwrap_or(p));
    if let Some(p) = &path
        && let Some(label) = docs.window_for_path(p)
        && let Some(w) = app.get_webview_window(&label)
    {
        return w.set_focus();
    }

    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    load(app, &label, path.clone(), None);
    build(app, &label, title_for(path.as_deref())).map(drop)
}

/// Open a new untitled document in a window of its own.
fn open_untitled(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    load(app, &label, None, None);
    build(app, &label, title_for(None))
}

/// An untitled window holding `text`, unsaved (File › Import).
pub fn open_text(app: &AppHandle, text: &str) -> tauri::Result<()> {
    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    load(app, &label, None, None);
    let docs = app.state::<Docs>();
    if let Some(id) = docs.for_window(&label) {
        let flavor = app.state::<crate::settings::Store>().get().flavor;
        docs.with(id, |open| open.doc.replace_text(text, &flavor));
    }
    build(app, &label, title_for(None)).map(drop)
}

/// File › New Tab: an untitled document in a new tab of `parent`'s window.
pub fn open_tab(app: &AppHandle, parent: &WebviewWindow) -> tauri::Result<()> {
    let window = open_untitled(app)?;
    #[cfg(target_os = "macos")]
    if let (Ok(parent), Ok(child)) = (parent.ns_window(), window.ns_window()) {
        // SAFETY: both are live NSWindows of these windows; menu events arrive on the
        // main thread.
        unsafe {
            tab_button::attach(
                &*(parent as *const objc2_app_kit::NSWindow),
                &*(child as *const objc2_app_kit::NSWindow),
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (parent, window);
    Ok(())
}

/// Open `dir` in a new window's sidebar, as Typora opens a folder, with no document.
pub fn open_folder(app: &AppHandle, dir: PathBuf) -> tauri::Result<()> {
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    library::remember_folder(app, &dir);
    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    load(app, &label, None, Some(dir));
    build(app, &label, "Untitled".to_owned()).map(drop)
}

/// Show the Preferences window, opening it the first time, at `panel` ("image", ...)
/// when given.
pub fn open_preferences(app: &AppHandle, panel: Option<&str>) -> tauri::Result<()> {
    let hash = panel.map(|p| format!("#{p}")).unwrap_or_default();
    if let Some(w) = app.get_webview_window("preferences") {
        if !hash.is_empty() {
            w.eval(format!("location.hash = {hash:?}"))?;
        }
        return w.set_focus();
    }
    let builder = WebviewWindowBuilder::new(
        app,
        "preferences",
        WebviewUrl::App("preferences.html".into()),
    )
    .title("Preferences")
    .inner_size(800.0, 600.0)
    .min_inner_size(600.0, 400.0);
    let builder = match hash.is_empty() {
        true => builder,
        false => builder.initialization_script(format!("location.hash = {hash:?};")),
    };
    #[cfg(debug_assertions)]
    let builder = match env_pair("MARPORA_WINDOW_POS", ',') {
        Some((x, y)) => builder.position(x, y),
        None => builder,
    };
    builder.build()?.set_focus()
}

/// Debug builds: `MARPORA_BACKGROUND` opens windows without focus and keeps the app
/// from the front (lib.rs), for checks of the real app while the user works.
fn background() -> bool {
    cfg!(debug_assertions) && std::env::var_os("MARPORA_BACKGROUND").is_some()
}

fn build(app: &AppHandle, label: &str, title: String) -> tauri::Result<WebviewWindow> {
    let (width, height) = window_size();
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(420.0, 300.0)
        .focused(!background());
    #[cfg(target_os = "macos")]
    let builder = builder.tabbing_identifier("marpora-documents");
    // Debug builds: run `MARPORA_INIT_JS` once the editor is up (parity captures).
    #[cfg(debug_assertions)]
    let builder = match std::env::var("MARPORA_INIT_JS") {
        Ok(js) => builder.initialization_script(format!(
            "(function wait() {{ if (window.marpora) {{ {js} }} else setTimeout(wait, 50); }})();"
        )),
        Err(_) => builder,
    };
    let builder = match env_pair("MARPORA_WINDOW_POS", ',') {
        Some((x, y)) => builder.position(x, y),
        None => builder,
    };
    let window = builder.build()?;
    #[cfg(debug_assertions)]
    if std::env::var_os("MARPORA_DEVTOOLS").is_some() {
        window.open_devtools();
    }
    if !background() {
        window.set_focus()?;
    }
    #[cfg(target_os = "macos")]
    {
        tab_button::install(app);
        crate::context_menu::install(&window);
    }
    Ok(window)
}

/// The "+" in the macOS tab bar, which AppKit shows when the window answers
/// `newWindowForTab:`: it opens an untitled document in a new tab, as in Typora.
#[cfg(target_os = "macos")]
mod tab_button {
    use std::sync::{Once, OnceLock};

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, sel};
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Add the method to tao's window class, which exists once a window does.
    pub fn install(app: &AppHandle) {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let _ = APP.set(app.clone());
            let Some(class) = AnyClass::get(c"TaoWindow") else {
                return;
            };
            let imp: unsafe extern "C-unwind" fn(&NSWindow, Sel, *mut AnyObject) =
                new_window_for_tab;
            // SAFETY: the function takes what the "v@:@" encoding says: the window,
            // the selector and the sender, and returns nothing.
            unsafe {
                ffi::class_addMethod(
                    class as *const AnyClass as *mut AnyClass,
                    sel!(newWindowForTab:),
                    std::mem::transmute::<
                        unsafe extern "C-unwind" fn(&NSWindow, Sel, *mut AnyObject),
                        Imp,
                    >(imp),
                    c"v@:@".as_ptr(),
                );
            }
        });
    }

    unsafe extern "C-unwind" fn new_window_for_tab(this: &NSWindow, _: Sel, _: *mut AnyObject) {
        let Some(app) = APP.get() else { return };
        let Ok(window) = super::open_untitled(app) else {
            return;
        };
        let Ok(ns) = window.ns_window() else { return };
        // SAFETY: `ns_window` is the new window's NSWindow, alive while `window` is,
        // and AppKit calls this on the main thread.
        attach(this, unsafe { &*(ns as *const NSWindow) });
    }

    /// Show `tab` as a tab of `window`'s, in front.
    pub fn attach(window: &NSWindow, tab: &NSWindow) {
        window.addTabbedWindow_ordered(tab, NSWindowOrderingMode::Above);
        tab.makeKeyAndOrderFront(None);
    }
}

/// Show `path` in `window` in place of its document, unless another window shows it
/// already (that one is focused instead). The page reloads to show it.
pub fn replace(app: &AppHandle, window: &WebviewWindow, path: PathBuf) -> tauri::Result<()> {
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let docs = app.state::<Docs>();
    if let Some(label) = docs.window_for_path(&path)
        && let Some(w) = app.get_webview_window(&label)
    {
        return w.set_focus();
    }
    // Files opened from an opened folder keep it in the sidebar.
    let folder = docs
        .for_window(window.label())
        .and_then(|id| docs.with(id, |open| open.folder.clone()))
        .flatten()
        .filter(|dir| path.starts_with(dir));
    load(app, window.label(), Some(path.clone()), folder);
    set_title(window, Some(&path));
    window.reload()
}

/// Read `path` (or start an untitled document) as the document of window `label`.
fn load(app: &AppHandle, label: &str, path: Option<PathBuf>, folder: Option<PathBuf>) {
    let text = match &path {
        Some(p) => std::fs::read_to_string(p).unwrap_or_default(),
        None => String::new(),
    };
    if let Some(p) = &path {
        library::remember(app, p);
    }
    app.state::<Docs>().insert(
        label,
        OpenDoc {
            doc: Document::from_markdown(&text),
            path,
            disk: text,
            folder,
            draft: None,
        },
    );
    app.state::<Watcher>().update(app);
}

/// Default window size; `MARPORA_WINDOW_SIZE=WxH` overrides it (parity captures).
fn window_size() -> (f64, f64) {
    env_pair("MARPORA_WINDOW_SIZE", 'x').unwrap_or((1100.0, 760.0))
}

fn env_pair(name: &str, sep: char) -> Option<(f64, f64)> {
    let v = std::env::var(name).ok()?;
    let (a, b) = v.split_once(sep)?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

pub fn title_for(path: Option<&Path>) -> String {
    path.and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".to_owned())
}

pub fn set_title(window: &WebviewWindow, path: Option<&Path>) {
    let _ = window.set_title(&title_for(path));
}
