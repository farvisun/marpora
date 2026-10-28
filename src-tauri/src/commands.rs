//! IPC commands called by the editor (see web/src/ipc-tauri.ts).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use marpora_core::{Patch, PatchError};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::docs::Docs;
use crate::library::{self, Recent};
use crate::watch::{self, Watcher};
use crate::settings::{Settings, Store};
use crate::themes::{self, ThemeCss, ThemeInfo};
use crate::{menu, pandoc, windows};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDoc {
    id: u64,
    path: Option<String>,
    text: String,
    version: u64,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum PatchResult {
    Applied { ok: bool, version: u64 },
    Rejected { ok: bool, current: u64 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    path: String,
    version: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocText {
    text: String,
    version: u64,
}

type CmdResult<T> = Result<T, String>;

/// Paths the user picked in an export dialog and that are not written yet. The webview
/// may only write there, so a page cannot write files the user did not choose.
#[derive(Default)]
pub struct ExportGrants(Mutex<HashSet<PathBuf>>);

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command]
pub fn initial_document(window: WebviewWindow, docs: State<Docs>) -> CmdResult<OpenedDoc> {
    let id = docs
        .for_window(window.label())
        .ok_or("no document for this window")?;
    docs.with(id, |open| OpenedDoc {
        id,
        path: open.path.as_deref().map(path_string),
        text: open.doc.text(),
        version: open.doc.version(),
    })
    .ok_or_else(|| "document closed".into())
}

#[tauri::command]
pub fn apply_patch(doc_id: u64, patch: Patch, docs: State<Docs>) -> CmdResult<PatchResult> {
    let result = docs
        .with(doc_id, |open| open.doc.apply(&patch))
        .ok_or("document closed")?;
    Ok(match result {
        Ok(version) => PatchResult::Applied { ok: true, version },
        Err(PatchError::Stale { current, .. }) => PatchResult::Rejected { ok: false, current },
        Err(e) => return Err(e.to_string()),
    })
}

#[tauri::command]
pub fn document_text(doc_id: u64, docs: State<Docs>) -> CmdResult<DocText> {
    docs.with(doc_id, |open| DocText {
        text: open.doc.text(),
        version: open.doc.version(),
    })
    .ok_or_else(|| "document closed".into())
}

/// Replace the whole text (source mode). Returns the new version.
#[tauri::command]
pub fn set_document_text(
    doc_id: u64,
    text: String,
    docs: State<Docs>,
    store: State<Store>,
) -> CmdResult<u64> {
    let flavor = store.get().flavor;
    docs.with(doc_id, |open| {
        open.doc.replace_text(&text, &flavor);
        open.doc.version()
    })
    .ok_or_else(|| "document closed".into())
}

#[tauri::command]
pub fn is_dirty(doc_id: u64, docs: State<Docs>) -> bool {
    docs.with(doc_id, |open| open.doc.is_dirty()).unwrap_or(false)
}

/// Save to the document's path, asking for one when it has none or `save_as` is set.
#[tauri::command]
pub async fn save_document(
    app: AppHandle,
    window: WebviewWindow,
    doc_id: u64,
    save_as: bool,
    docs: State<'_, Docs>,
) -> CmdResult<Option<Saved>> {
    let (current, suggested) = docs
        .with(doc_id, |open| (open.path.clone(), suggested_name(&open.doc.text())))
        .ok_or("document closed")?;

    let path = match current {
        Some(p) if !save_as => p,
        _ => {
            let mut dialog = app
                .dialog()
                .file()
                .set_parent(&window)
                .add_filter("Markdown", &["md", "markdown"]);
            dialog = match &current {
                Some(p) => dialog.set_directory(p.parent().unwrap_or(Path::new("/"))).set_file_name(
                    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(suggested),
                ),
                None => dialog.set_file_name(suggested),
            };
            match dialog.blocking_save_file().and_then(|f| f.into_path().ok()) {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };

    let (text, version) = docs
        .with(doc_id, |open| (open.doc.text(), open.doc.version()))
        .ok_or("document closed")?;
    write_atomically(&path, &text).map_err(|e| format!("could not save {}: {e}", path.display()))?;
    // The watcher reports canonical paths.
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    docs.with(doc_id, |open| {
        open.doc.mark_saved(version);
        open.path = Some(path.clone());
        open.disk = text;
    });
    library::remember(&app, &path);
    app.state::<Watcher>().update(&app);
    windows::set_title(&window, Some(&path));
    Ok(Some(Saved {
        path: path_string(&path),
        version,
    }))
}

/// Ask where to export the document, next to it and named after it by default.
#[tauri::command]
pub async fn export_path(
    app: AppHandle,
    window: WebviewWindow,
    doc_id: u64,
    format: String,
    extension: String,
    docs: State<'_, Docs>,
    grants: State<'_, ExportGrants>,
) -> CmdResult<Option<String>> {
    let Some(path) = ask_export_path(&app, &window, doc_id, &format, &extension, &docs)? else {
        return Ok(None);
    };
    grants.0.lock().unwrap().insert(path.clone());
    Ok(Some(path_string(&path)))
}

fn ask_export_path(
    app: &AppHandle,
    window: &WebviewWindow,
    doc_id: u64,
    format: &str,
    extension: &str,
    docs: &Docs,
) -> CmdResult<Option<PathBuf>> {
    let (current, suggested) = docs
        .with(doc_id, |open| (open.path.clone(), suggested_name(&open.doc.text())))
        .ok_or("document closed")?;
    let stem = current
        .as_deref()
        .and_then(Path::file_stem)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| suggested.trim_end_matches(".md").to_owned());
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(window)
        .add_filter(format, &[extension])
        .set_file_name(format!("{stem}.{extension}"));
    if let Some(dir) = current.as_deref().and_then(Path::parent) {
        dialog = dialog.set_directory(dir);
    }
    // Debug builds: `MARPORA_EXPORT_TO` answers the dialog (export checks).
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("MARPORA_EXPORT_TO") {
        return Ok(Some(PathBuf::from(p)));
    }
    Ok(dialog.blocking_save_file().and_then(|f| f.into_path().ok()))
}

/// Export the document through Pandoc as `format` (see pandoc.rs). `false` when the
/// user cancelled the save dialog.
#[tauri::command]
pub async fn export_pandoc(
    app: AppHandle,
    window: WebviewWindow,
    doc_id: u64,
    format: String,
    docs: State<'_, Docs>,
) -> CmdResult<bool> {
    let format = pandoc::format(&format).ok_or_else(|| format!("unknown export format {format}"))?;
    let home = app.path().home_dir().ok();
    let Some(pandoc) = pandoc::find(std::env::var_os("PATH").as_deref(), home.as_deref()) else {
        return Err(format!(
            "Exporting to {} needs Pandoc. Install it from https://pandoc.org/installing.html and try again.",
            format.name
        ));
    };
    let Some(path) = ask_export_path(&app, &window, doc_id, format.name, format.extension, &docs)? else {
        return Ok(false);
    };
    let (text, dir) = docs
        .with(doc_id, |open| (open.doc.text(), open.path.as_deref().and_then(Path::parent).map(Path::to_path_buf)))
        .ok_or("document closed")?;
    tauri::async_runtime::spawn_blocking(move || pandoc::convert(&pandoc, format, &text, &path, dir.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(true)
}

/// Write an export the user chose the path for (see `export_path`).
#[tauri::command]
pub fn write_export(path: String, contents: String, grants: State<ExportGrants>) -> CmdResult<()> {
    let path = PathBuf::from(path);
    if !grants.0.lock().unwrap().remove(&path) {
        return Err(format!("{} was not chosen for export", path.display()));
    }
    write_atomically(&path, &contents).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Export the page `html` (from the editor's HTML export) as a PDF at `path`, a path
/// the user chose through `export_path`.
#[tauri::command]
pub async fn export_pdf(
    window: WebviewWindow,
    path: String,
    html: String,
    grants: State<'_, ExportGrants>,
) -> CmdResult<()> {
    let path = PathBuf::from(path);
    if !grants.0.lock().unwrap().remove(&path) {
        return Err(format!("{} was not chosen for export", path.display()));
    }
    print_page(window, html, Some(path)).await
}

/// Print the page `html` through the print panel.
#[tauri::command]
pub async fn print_page_html(window: WebviewWindow, html: String) -> CmdResult<()> {
    print_page(window, html, None).await
}

#[cfg(target_os = "macos")]
async fn print_page(window: WebviewWindow, html: String, pdf: Option<PathBuf>) -> CmdResult<()> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let page = std::env::temp_dir().join(format!(
        "marpora-print-{}-{}.html",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let style = format!("<style type='text/css'>{}</style>", crate::pdf::page_css());
    let html = match html.find("</head>") {
        Some(i) => format!("{}{style}{}", &html[..i], &html[i..]),
        None => format!("{style}{html}"),
    };
    std::fs::write(&page, html).map_err(|e| format!("could not write {}: {e}", page.display()))?;

    let (tx, rx) = std::sync::mpsc::channel();
    let file = page.clone();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let output = match pdf {
                Some(path) => crate::pdf::Output::Pdf(path),
                None => crate::pdf::Output::Printer,
            };
            let done = Box::new(move |r| {
                let _ = tx.send(r);
            });
            match target.ns_window() {
                // SAFETY: the window is alive while its command runs, and this is the main thread.
                Ok(ns) => crate::pdf::print(unsafe { &*(ns as *const objc2_app_kit::NSWindow) }, &file, output, done),
                Err(e) => done(Err(e.to_string())),
            }
        })
        .map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|_| Err("printing stopped".into()));
    let _ = std::fs::remove_file(&page);
    result
}

#[cfg(not(target_os = "macos"))]
async fn print_page(_window: WebviewWindow, _html: String, _pdf: Option<PathBuf>) -> CmdResult<()> {
    Err("printing is not available on this platform yet".into())
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> CmdResult<()> {
    windows::open(&app, Some(PathBuf::from(path))).map_err(|e| e.to_string())
}

/// Open `path` from the sidebar or Quick Open: in this window when its document has no
/// unsaved changes, otherwise in a new one.
#[tauri::command]
pub fn open_here(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    docs: State<Docs>,
) -> CmdResult<()> {
    let dirty = docs
        .for_window(window.label())
        .and_then(|id| docs.with(id, |open| open.doc.is_dirty()))
        .unwrap_or(false);
    let path = PathBuf::from(path);
    if dirty {
        windows::open(&app, Some(path))
    } else {
        windows::replace(&app, &window, path)
    }
    .map_err(|e| e.to_string())
}

/// Replace the document with its file on disk, after it changed there (`disk-changed`)
/// and the user chose to drop their edits.
#[tauri::command]
pub fn reload_document(app: AppHandle, window: WebviewWindow, doc_id: u64) -> CmdResult<()> {
    watch::reload(&app, window.label(), doc_id)
}

/// The folder the sidebar's Files tab shows: an opened folder, else the document's.
fn library_root(window: &WebviewWindow, docs: &Docs) -> Option<PathBuf> {
    let id = docs.for_window(window.label())?;
    let (path, folder) = docs.with(id, |open| (open.path.clone(), open.folder.clone()))?;
    if folder.is_some() {
        return folder;
    }
    let path = path?;
    let dir = path.parent()?;
    Some(std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    folder: Option<String>,
    /// The folder was opened with File › Open Folder (the sidebar shows it at once).
    opened_folder: bool,
    /// The home folder, which the sidebar and Quick Open write as `~`.
    home: Option<String>,
}

#[tauri::command]
pub fn library_info(window: WebviewWindow, docs: State<Docs>) -> LibraryInfo {
    let opened_folder = docs
        .for_window(window.label())
        .and_then(|id| docs.with(id, |open| open.folder.is_some()))
        .unwrap_or(false);
    LibraryInfo {
        folder: library_root(&window, &docs).as_deref().map(path_string),
        opened_folder,
        home: std::env::var("HOME").ok(),
    }
}

/// One level of the file tree; `path` must be inside the library folder.
#[tauri::command]
pub async fn list_folder(
    window: WebviewWindow,
    path: String,
    docs: State<'_, Docs>,
) -> CmdResult<Vec<library::Entry>> {
    let root = library_root(&window, &docs).ok_or("no folder is open")?;
    let dir = PathBuf::from(path);
    if !library::contains(&root, &dir) {
        return Err(format!("{} is outside {}", dir.display(), root.display()));
    }
    tauri::async_runtime::spawn_blocking(move || library::list_dir(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// The Markdown files in the library folder, with summaries (the article list) or
/// without (Quick Open, which lists more).
#[tauri::command]
pub async fn list_documents(
    window: WebviewWindow,
    summaries: bool,
    docs: State<'_, Docs>,
) -> CmdResult<library::Docs> {
    let Some(root) = library_root(&window, &docs) else {
        return Ok(library::Docs {
            files: Vec::new(),
            oversize: false,
        });
    };
    let limit = if summaries {
        library::MAX_LIST
    } else {
        library::MAX_QUICK_OPEN
    };
    tauri::async_runtime::spawn_blocking(move || library::walk(&root, limit, summaries))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recent_files(recent: State<Recent>) -> Vec<String> {
    recent.files()
}

/// Frontend errors, printed where `tauri dev` shows them.
#[tauri::command]
pub fn frontend_log(window: WebviewWindow, message: String) {
    eprintln!("[{}] {message}", window.label());
}

#[tauri::command]
pub fn get_settings(store: State<Store>) -> Settings {
    store.get()
}

#[tauri::command]
pub fn list_themes(app: AppHandle) -> Vec<ThemeInfo> {
    themes::list(&app)
}

#[tauri::command]
pub fn load_theme(app: AppHandle, id: String) -> Option<ThemeCss> {
    themes::load(&app, &id)
}

#[tauri::command]
pub fn set_theme(app: AppHandle, id: String) {
    menu::set_theme(&app, &id);
}

/// Write via a temporary file in the same directory so a crash never leaves half a file.
fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.marpora-tmp"));
    std::fs::write(&tmp, text)?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path)
}

/// File name for an untitled document: its first heading, like Typora.
fn suggested_name(text: &str) -> String {
    let title = text
        .lines()
        .find_map(|l| l.trim_start().strip_prefix('#').map(|h| h.trim_start_matches('#').trim()))
        .filter(|t| !t.is_empty())
        .unwrap_or("Untitled");
    let clean: String = title
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .take(80)
        .collect();
    format!("{clean}.md")
}
