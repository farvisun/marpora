//! Document windows: one document per window, as in Typora on macOS.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use marpora_core::Document;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::docs::{Docs, OpenDoc};
use crate::library::Recent;
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
    load(app, &label, path.clone());

    let (width, height) = window_size();
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title_for(path.as_deref()))
        .inner_size(width, height)
        .min_inner_size(420.0, 300.0);
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
    window.set_focus()?;
    Ok(())
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
    load(app, window.label(), Some(path.clone()));
    set_title(window, Some(&path));
    window.reload()
}

/// Read `path` (or start an untitled document) as the document of window `label`.
fn load(app: &AppHandle, label: &str, path: Option<PathBuf>) {
    let text = match &path {
        Some(p) => std::fs::read_to_string(p).unwrap_or_default(),
        None => String::new(),
    };
    if let Some(p) = &path {
        app.state::<Recent>().add(p);
    }
    app.state::<Docs>().insert(
        label,
        OpenDoc {
            doc: Document::from_markdown(&text),
            path,
            disk: text,
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
