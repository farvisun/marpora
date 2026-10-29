//! Writing documents to disk: File › Save, Auto Save and backups of unsaved drafts,
//! like Typora's "Save & Recover" preferences.
//!
//! Every edit restarts a short timer for its document. When the document has been
//! quiet for `SETTLE`, it is saved to its file if Auto Save is on, and otherwise its
//! unsaved text is copied to `draftsRecover` in the app data folder. A draft survives
//! a crash, a quit, or closing the window with "Don't Save", and is deleted once the
//! document is saved.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Manager};

use crate::docs::Docs;
use crate::settings::Store;
use crate::watch::Watcher;

/// How long a document is left alone before it is saved or backed up.
const SETTLE: Duration = Duration::from_secs(2);
/// Drafts older than this are deleted when the app starts.
const KEEP_DRAFTS: Duration = Duration::from_secs(30 * 24 * 3600);

/// Runs `settle` for documents that stopped changing.
pub struct Autosave {
    tx: mpsc::Sender<u64>,
}

impl Autosave {
    pub fn start(app: &AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();
        let app = app.clone();
        std::thread::spawn(move || {
            let mut due: HashMap<u64, Instant> = HashMap::new();
            loop {
                let next = due.values().min().copied();
                let received = match next {
                    Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
                    None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match received {
                    Ok(id) => {
                        due.insert(id, Instant::now() + SETTLE);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                let now = Instant::now();
                due.retain(|&id, at| {
                    if *at > now {
                        return true;
                    }
                    settle(&app, id);
                    false
                });
            }
        });
        Autosave { tx }
    }

    /// Document `id` changed.
    pub fn touch(&self, id: u64) {
        let _ = self.tx.send(id);
    }
}

/// Save or back up document `id` if it has unsaved edits. Also called when its window
/// closes and when the app quits.
pub fn settle(app: &AppHandle, id: u64) {
    let settings = app.state::<Store>().get();
    let docs = app.state::<Docs>();
    let Some((dirty, path)) = docs.with(id, |open| (open.doc.is_dirty(), open.path.clone())) else {
        return;
    };
    if !dirty {
        return;
    }
    match path {
        Some(path) if settings.auto_save => {
            if let Err(e) = save_to(app, id, &path) {
                eprintln!("{e}");
            }
        }
        _ if settings.backup_unsaved_drafts => backup(app, id),
        _ => {}
    }
}

/// Settle every open document (the app is quitting).
pub fn settle_all(app: &AppHandle) {
    for id in app.state::<Docs>().ids() {
        settle(app, id);
    }
}

/// Write document `id` to `path` and make that its file. Returns the canonical path
/// and the version written.
pub fn save_to(app: &AppHandle, id: u64, path: &Path) -> Result<(PathBuf, u64), String> {
    let docs = app.state::<Docs>();
    let final_newline = app
        .state::<crate::settings::Store>()
        .get()
        .insert_final_newline;
    // `disk` is set first so the watcher takes the write for our own.
    let (text, version, before) = docs
        .with(id, |open| {
            let mut text = open.doc.text();
            if final_newline && !text.is_empty() && !text.ends_with('\n') {
                text.push_str(if open.doc.crlf() { "\r\n" } else { "\n" });
            }
            let before = std::mem::replace(&mut open.disk, text.clone());
            (text, open.doc.version(), before)
        })
        .ok_or("document closed")?;
    if let Err(e) = write_atomically(path, &text) {
        docs.with(id, |open| open.disk = before);
        return Err(format!("could not save {}: {e}", path.display()));
    }
    // The watcher reports canonical paths.
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let draft = docs
        .with(id, |open| {
            open.doc.mark_saved(version);
            open.path = Some(path.clone());
            open.draft.take()
        })
        .flatten();
    if let Some(draft) = draft {
        let _ = std::fs::remove_file(draft);
    }
    app.state::<Watcher>().update(app);
    Ok((path, version))
}

/// Write via a temporary file in the same directory so a crash never leaves half a file.
pub fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.marpora-tmp"));
    std::fs::write(&tmp, text)?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path)
}

/// Where drafts are kept (Typora's folder name).
pub fn drafts_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("draftsRecover"))
}

/// Copy document `id`'s text to its draft, creating one the first time.
fn backup(app: &AppHandle, id: u64) {
    let Some(dir) = drafts_dir(app) else {
        return;
    };
    let docs = app.state::<Docs>();
    let Some((text, path, draft)) = docs.with(id, |open| {
        (open.doc.text(), open.path.clone(), open.draft.clone())
    }) else {
        return;
    };
    // A draft opened for recovery is not backed up again.
    if text.trim().is_empty() || path.as_deref().is_some_and(|p| p.starts_with(&dir)) {
        return;
    }
    let draft = draft.unwrap_or_else(|| {
        let stem = path.as_deref().and_then(Path::file_stem);
        unused(
            &dir,
            &draft_name(stem.map(|s| s.to_string_lossy()).as_deref()),
        )
    });
    let written = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&draft, text));
    match written {
        Ok(()) => {
            docs.with(id, |open| open.draft = Some(draft));
        }
        Err(e) => eprintln!("could not back up a draft to {}: {e}", draft.display()),
    }
}

/// `2026-10-29 notes 153012.md`, as Typora names drafts.
fn draft_name(stem: Option<&str>) -> String {
    let now = chrono::Local::now();
    format!(
        "{} {} {}.md",
        now.format("%Y-%m-%d"),
        stem.unwrap_or("untitled"),
        now.format("%H%M%S")
    )
}

/// `dir/name`, or `dir/name-2.md` and so on when that exists.
fn unused(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    if !path.exists() {
        return path;
    }
    let stem = name.trim_end_matches(".md");
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}.md")))
        .find(|p| !p.exists())
        .expect("some name is free")
}

/// Delete drafts last written before `KEEP_DRAFTS` ago.
pub fn prune_drafts(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).unwrap_or_default() > KEEP_DRAFTS);
        if old && entry.path().extension().is_some_and(|e| e == "md") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafts_are_named_like_typora() {
        let name = draft_name(Some("notes"));
        let parts: Vec<&str> = name.trim_end_matches(".md").split(' ').collect();
        assert_eq!(parts.len(), 3, "{name}");
        assert_eq!(parts[0].len(), 10);
        assert_eq!(parts[1], "notes");
        assert!(parts[2].len() == 6 && parts[2].chars().all(|c| c.is_ascii_digit()));
        assert!(draft_name(None).contains(" untitled "));
    }

    #[test]
    fn names_never_overwrite_drafts() {
        let dir = std::env::temp_dir().join(format!("marpora-drafts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unused(&dir, "a.md"), dir.join("a.md"));
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("a-2.md"), "x").unwrap();
        assert_eq!(unused(&dir, "a.md"), dir.join("a-3.md"));
        prune_drafts(&dir);
        assert!(dir.join("a.md").exists(), "new drafts are kept");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
