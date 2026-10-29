//! IPC commands called by the editor (see web/src/ipc-tauri.ts).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use marpora_core::{Patch, PatchError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::docs::Docs;
use crate::images;
use crate::library::{self, Recent};
use crate::links::{self, Target};
use crate::save::{self, Autosave};
use crate::search::{self, Searches};
use crate::settings::{Settings, Store};
use crate::themes::{self, ThemeCss, ThemeInfo};
use crate::watch;
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
pub fn apply_patch(
    doc_id: u64,
    patch: Patch,
    docs: State<Docs>,
    autosave: State<Autosave>,
) -> CmdResult<PatchResult> {
    let result = docs
        .with(doc_id, |open| open.doc.apply(&patch))
        .ok_or("document closed")?;
    autosave.touch(doc_id);
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
    autosave: State<Autosave>,
) -> CmdResult<u64> {
    let flavor = store.get().flavor;
    let version = docs
        .with(doc_id, |open| {
            open.doc.replace_text(&text, &flavor);
            open.doc.version()
        })
        .ok_or("document closed")?;
    autosave.touch(doc_id);
    Ok(version)
}

#[tauri::command]
pub fn is_dirty(doc_id: u64, docs: State<Docs>) -> bool {
    docs.with(doc_id, |open| open.doc.is_dirty())
        .unwrap_or(false)
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
        .with(doc_id, |open| {
            (open.path.clone(), suggested_name(&open.doc.text()))
        })
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
                Some(p) => dialog
                    .set_directory(p.parent().unwrap_or(Path::new("/")))
                    .set_file_name(
                        p.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or(suggested),
                    ),
                None => dialog.set_file_name(suggested),
            };
            match dialog.blocking_save_file().and_then(|f| f.into_path().ok()) {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };

    let (path, version) = save::save_to(&app, doc_id, &path)?;
    library::remember(&app, &path);
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
        .with(doc_id, |open| {
            (open.path.clone(), suggested_name(&open.doc.text()))
        })
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
    let format =
        pandoc::format(&format).ok_or_else(|| format!("unknown export format {format}"))?;
    let home = app.path().home_dir().ok();
    let Some(pandoc) = pandoc::find(std::env::var_os("PATH").as_deref(), home.as_deref()) else {
        return Err(format!(
            "Exporting to {} needs Pandoc. Install it from https://pandoc.org/installing.html and try again.",
            format.name
        ));
    };
    let Some(path) = ask_export_path(&app, &window, doc_id, format.name, format.extension, &docs)?
    else {
        return Ok(false);
    };
    let (text, dir) = docs
        .with(doc_id, |open| {
            (
                open.doc.text(),
                open.path
                    .as_deref()
                    .and_then(Path::parent)
                    .map(Path::to_path_buf),
            )
        })
        .ok_or("document closed")?;
    tauri::async_runtime::spawn_blocking(move || {
        pandoc::convert(&pandoc, format, &text, &path, dir.as_deref())
    })
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
    save::write_atomically(&path, &contents)
        .map_err(|e| format!("could not write {}: {e}", path.display()))
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
    print_page(window, html, PageOutput::Pdf(path)).await
}

/// Export the page `html` as a PNG image of all of it at `path`, a path the user chose
/// through `export_path`.
#[tauri::command]
pub async fn export_image(
    window: WebviewWindow,
    path: String,
    html: String,
    grants: State<'_, ExportGrants>,
) -> CmdResult<()> {
    let path = PathBuf::from(path);
    if !grants.0.lock().unwrap().remove(&path) {
        return Err(format!("{} was not chosen for export", path.display()));
    }
    print_page(window, html, PageOutput::Png(path)).await
}

/// Print the page `html` through the print panel.
#[tauri::command]
pub async fn print_page_html(window: WebviewWindow, html: String) -> CmdResult<()> {
    print_page(window, html, PageOutput::Printer).await
}

/// Where `print_page` sends the page.
enum PageOutput {
    Pdf(PathBuf),
    Png(PathBuf),
    Printer,
}

#[cfg(target_os = "macos")]
async fn print_page(window: WebviewWindow, html: String, output: PageOutput) -> CmdResult<()> {
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
            let output = match output {
                PageOutput::Pdf(path) => crate::pdf::Output::Pdf(path),
                PageOutput::Png(path) => crate::pdf::Output::Png(path),
                PageOutput::Printer => crate::pdf::Output::Printer,
            };
            let done = Box::new(move |r| {
                let _ = tx.send(r);
            });
            match target.ns_window() {
                // SAFETY: the window is alive while its command runs, and this is the main thread.
                Ok(ns) => crate::pdf::print(
                    unsafe { &*(ns as *const objc2_app_kit::NSWindow) },
                    &file,
                    output,
                    done,
                ),
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
async fn print_page(_window: WebviewWindow, _html: String, _output: PageOutput) -> CmdResult<()> {
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
    store: State<'_, Store>,
) -> CmdResult<Vec<library::Entry>> {
    let root = library_root(&window, &docs).ok_or("no folder is open")?;
    let hidden = store.get().show_hidden_files;
    let dir = PathBuf::from(path);
    if !library::contains(&root, &dir) {
        return Err(format!("{} is outside {}", dir.display(), root.display()));
    }
    tauri::async_runtime::spawn_blocking(move || library::list_dir(&dir, hidden))
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
    store: State<'_, Store>,
) -> CmdResult<library::Docs> {
    let hidden = store.get().show_hidden_files;
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
    tauri::async_runtime::spawn_blocking(move || library::walk(&root, limit, summaries, hidden))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recent_files(recent: State<Recent>) -> Vec<String> {
    recent.files()
}

#[tauri::command]
pub fn recent_folders(recent: State<Recent>) -> Vec<String> {
    recent.folders()
}

/// Find in the sidebar's folder (its Search). A newer search stops this one.
#[tauri::command]
pub async fn search_library(
    app: AppHandle,
    window: WebviewWindow,
    query: search::Query,
    docs: State<'_, Docs>,
    store: State<'_, Store>,
) -> CmdResult<search::Results> {
    let root = library_root(&window, &docs).ok_or("no folder is open")?;
    let hidden = store.get().show_hidden_files;
    let id = app.state::<Searches>().start();
    tauri::async_runtime::spawn_blocking(move || {
        let searches = app.state::<Searches>();
        search::search(&root, &query, hidden, || searches.current() != id)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Create an untitled file in the sidebar's folder (its footer's New File). Returns
/// its path; the window opens it.
#[tauri::command]
pub fn new_library_file(
    window: WebviewWindow,
    dir: Option<String>,
    folder: Option<bool>,
    docs: State<Docs>,
) -> CmdResult<String> {
    let dir = match dir {
        Some(d) => in_library(&window, &docs, &d, true)?,
        None => library_root(&window, &docs).ok_or("no folder is open")?,
    };
    let created = if folder.unwrap_or(false) {
        let path = dir.join(library::untitled_folder_name(&dir));
        std::fs::create_dir(&path).map(|_| path)
    } else {
        let path = dir.join(library::untitled_name(&dir));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(|_| path)
    };
    let path = created.map_err(|e| format!("could not create a file in {}: {e}", dir.display()))?;
    Ok(path_string(&path))
}

/// `path`, made canonical, if it is in this window's sidebar folder: the folder itself
/// only with `root`. Sidebar file commands only touch what the sidebar shows.
fn in_library(window: &WebviewWindow, docs: &Docs, path: &str, root: bool) -> CmdResult<PathBuf> {
    let dir = library_root(window, docs).ok_or("no folder is open")?;
    let path = std::fs::canonicalize(path).map_err(|e| format!("could not find {path}: {e}"))?;
    if !path.starts_with(&dir) || (path == dir && !root) {
        return Err(format!("{} is not in the sidebar's folder", path.display()));
    }
    Ok(path)
}

/// Copy `path` next to it as `name (copy).md` (the sidebar's Duplicate); returns the copy.
#[tauri::command]
pub fn duplicate_library_file(
    window: WebviewWindow,
    path: String,
    docs: State<Docs>,
) -> CmdResult<String> {
    let path = in_library(&window, &docs, &path, false)?;
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let dir = path.parent().ok_or("no folder")?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let copy = dir.join(library::copy_name(&name, |n| dir.join(n).exists()));
    std::fs::copy(&path, &copy).map_err(|e| format!("could not copy {}: {e}", path.display()))?;
    Ok(path_string(&copy))
}

/// Move `path` to the Trash (the sidebar's Delete).
#[tauri::command]
pub fn trash_library_file(window: WebviewWindow, path: String, docs: State<Docs>) -> CmdResult<()> {
    trash(&in_library(&window, &docs, &path, false)?)
}

#[cfg(target_os = "macos")]
fn trash(path: &Path) -> CmdResult<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| {
            format!(
                "could not move {} to the Trash: {}",
                path.display(),
                e.localizedDescription()
            )
        })
}

#[cfg(not(target_os = "macos"))]
fn trash(_path: &Path) -> CmdResult<()> {
    Err("moving files to the Trash is not available on this platform yet".into())
}

/// Show `path` selected in Finder (the sidebar's Open File Location).
#[tauri::command]
pub fn reveal_library_file(
    window: WebviewWindow,
    path: String,
    docs: State<Docs>,
) -> CmdResult<()> {
    let path = in_library(&window, &docs, &path, true)?;
    #[cfg(target_os = "macos")]
    return std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(drop)
        .map_err(|e| format!("could not show {}: {e}", path.display()));
    #[cfg(not(target_os = "macos"))]
    reveal(path.parent().unwrap_or(&path))
}

/// Open `path`, a file or a folder from the sidebar, in a new window.
#[tauri::command]
pub fn open_library_file_in_window(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    docs: State<Docs>,
) -> CmdResult<()> {
    let path = in_library(&window, &docs, &path, true)?;
    let opened = match path.is_dir() {
        true => windows::open_folder(&app, path),
        false => windows::open(&app, Some(path)),
    };
    opened.map_err(|e| e.to_string())
}

/// Rename `path`, a file or folder under the sidebar's folder, to `name` in the same
/// folder (the sidebar's inline rename). Windows showing it, or a file in it, follow
/// it. Returns the new path.
#[tauri::command]
pub fn rename_library_file(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    name: String,
    docs: State<Docs>,
) -> CmdResult<String> {
    let root = library_root(&window, &docs).ok_or("no folder is open")?;
    let old = std::fs::canonicalize(&path).map_err(|e| format!("could not find {path}: {e}"))?;
    if old == root || !old.starts_with(&root) {
        return Err(format!("{path} is not in the sidebar's folder"));
    }
    let name = library::clean_file_name(&name).ok_or("the name is empty")?;
    let new = old.with_file_name(&name);
    if new == old {
        return Ok(path_string(&old));
    }
    // Another file; a change of case only names the same file on a case-insensitive disk.
    if new.exists() && !same_file(&old, &new) {
        return Err("File with same name already exists at target path.".into());
    }
    std::fs::rename(&old, &new).map_err(|e| format!("could not rename {path}: {e}"))?;
    for (label, moved) in docs.renamed(&old, &new) {
        if let Some(w) = app.get_webview_window(&label) {
            windows::set_title(&w, Some(&moved));
            let _ = w.emit_to(&label, "path-changed", path_string(&moved));
        }
    }
    app.state::<watch::Watcher>().update(&app);
    Ok(path_string(&new))
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(_a: &Path, _b: &Path) -> bool {
    false
}

/// Store a pasted image (the request's body, an `x-ext` file) for document `x-doc-id`
/// where the image setting says; returns how the document refers to it.
#[tauri::command]
pub fn save_image(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
    docs: State<Docs>,
    store: State<Store>,
) -> CmdResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image's bytes".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let id: u64 = header("x-doc-id")
        .and_then(|v| v.parse().ok())
        .ok_or("no document given")?;
    let doc = docs
        .with(id, |open| open.path.clone())
        .ok_or("document closed")?;
    let settings = store.get();
    let user_images = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("user-images");
    let dir = images::storage_dir(&settings.image_storage, doc.as_deref(), &user_images);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join(images::file_name(header("x-ext").unwrap_or("png"))?);
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(images::src_for(
        &path,
        doc.as_deref(),
        settings.use_relative_image_path,
    ))
}

/// Show the sidebar's folder in Finder.
#[tauri::command]
pub fn reveal_library(window: WebviewWindow, docs: State<Docs>) -> CmdResult<()> {
    reveal(&library_root(&window, &docs).ok_or("no folder is open")?)
}

/// Show `dir`, one of the recent folders, in this window's sidebar instead of its
/// current folder. Without `dir`, ask for one. Returns false when the user cancelled.
#[tauri::command]
pub async fn switch_library_folder(
    app: AppHandle,
    window: WebviewWindow,
    dir: Option<String>,
    docs: State<'_, Docs>,
    recent: State<'_, Recent>,
) -> CmdResult<bool> {
    let dir = match dir {
        // Only folders the user opened before, so a page cannot point the sidebar
        // (and `list_folder`) anywhere it likes.
        Some(d) if recent.folders().contains(&d) => PathBuf::from(d),
        Some(d) => return Err(format!("{d} is not a recent folder")),
        None => match app
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
            .and_then(|d| d.into_path().ok())
        {
            Some(d) => d,
            None => return Ok(false),
        },
    };
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    let id = docs
        .for_window(window.label())
        .ok_or("no document for this window")?;
    docs.with(id, |open| open.folder = Some(dir.clone()));
    library::remember_folder(&app, &dir);
    Ok(true)
}

#[tauri::command]
pub fn clear_recent(app: AppHandle, recent: State<Recent>) {
    recent.clear();
    menu::refresh_recent(&app);
}

/// Change some settings (Preferences); `patch` holds camelCase fields.
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    patch: serde_json::Value,
    store: State<Store>,
) -> CmdResult<Settings> {
    store.merge(&app, patch)
}

/// Show the drafts folder in Finder (Preferences › Recover Unsaved Drafts).
#[tauri::command]
pub fn open_drafts_folder(app: AppHandle) -> CmdResult<()> {
    reveal(&save::drafts_dir(&app).ok_or("no drafts folder")?)
}

/// Show the user themes folder in Finder (Preferences › Open Theme Folder).
#[tauri::command]
pub fn open_theme_folder(app: AppHandle) -> CmdResult<()> {
    reveal(&themes::user_dir(&app).ok_or("no themes folder")?)
}

/// Open a link from the document (see links.rs): Markdown files in a new window, other
/// files and addresses with the system. A `#heading` link comes back for the editor to
/// scroll to.
#[tauri::command]
pub fn open_link(
    app: AppHandle,
    window: WebviewWindow,
    href: String,
    docs: State<Docs>,
) -> CmdResult<Option<String>> {
    let doc = docs
        .for_window(window.label())
        .and_then(|id| docs.with(id, |open| open.path.clone()))
        .flatten();
    match links::resolve(&href, doc.as_deref())? {
        Target::Anchor(heading) => Ok(Some(heading)),
        Target::External(url) => system_open(url.as_ref()).map(|()| None),
        Target::File(path) if !path.exists() => Err(format!("{} does not exist", path.display())),
        Target::File(path) if path.is_file() && library::is_markdown(&path) => {
            windows::open(&app, Some(path)).map_err(|e| e.to_string())?;
            Ok(None)
        }
        Target::File(path) => system_open(path.as_os_str()).map(|()| None),
    }
}

/// Open folder `dir` in the file manager, creating it first.
fn reveal(dir: &Path) -> CmdResult<()> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    system_open(dir.as_os_str())
}

/// Open `target`, a path or an address, with the system's handler for it.
fn system_open(target: &std::ffi::OsStr) -> CmdResult<()> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(target)
        .spawn()
        .map(drop)
        .map_err(|e| format!("could not open {}: {e}", target.display()))
}

/// The user cancelled closing a window, so File › Quit stops.
#[tauri::command]
pub fn cancel_quit(quitting: State<menu::Quitting>) {
    quitting.0.store(false, std::sync::atomic::Ordering::SeqCst);
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

/// File name for an untitled document: its first heading, like Typora.
fn suggested_name(text: &str) -> String {
    let title = text
        .lines()
        .find_map(|l| {
            l.trim_start()
                .strip_prefix('#')
                .map(|h| h.trim_start_matches('#').trim())
        })
        .filter(|t| !t.is_empty())
        .unwrap_or("Untitled");
    let clean: String = title
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .take(80)
        .collect();
    format!("{clean}.md")
}
