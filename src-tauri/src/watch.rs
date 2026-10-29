//! Reload documents changed on disk by other programs. The folders of open documents
//! are watched (not the files, which editors often replace by renaming). A change to a
//! document with no unsaved edits is applied in place as a block-level patch, so the
//! window keeps its scroll position and selection. With unsaved edits, the window is
//! asked first (`disk-changed`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use marpora_core::RemotePatch;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::docs::Docs;
use crate::settings::Store;

#[derive(Default)]
pub struct Watcher {
    inner: Mutex<Option<RecommendedWatcher>>,
    dirs: Mutex<HashSet<PathBuf>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemotePatchEvent {
    pub doc_id: u64,
    pub patch: RemotePatch,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskChanged {
    doc_id: u64,
}

/// What a change on disk means for one open document.
enum Outcome {
    Applied(RemotePatch),
    Conflict,
}

impl Watcher {
    /// Watch the folders of the open documents, and only those.
    pub fn update(&self, app: &AppHandle) {
        let wanted: HashSet<PathBuf> = app
            .state::<Docs>()
            .paths()
            .iter()
            .filter_map(|p| p.parent().map(Path::to_path_buf))
            .collect();
        let mut inner = self.inner.lock().unwrap();
        if inner.is_none() {
            let handle = app.clone();
            let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res
                    && matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_))
                {
                    for path in &event.paths {
                        changed(&handle, path);
                    }
                }
            });
            match watcher {
                Ok(w) => *inner = Some(w),
                Err(e) => return eprintln!("could not watch files: {e}"),
            }
        }
        let watcher = inner.as_mut().expect("created above");
        let mut dirs = self.dirs.lock().unwrap();
        for dir in dirs.difference(&wanted) {
            let _ = watcher.unwatch(dir);
        }
        for dir in wanted.difference(&dirs) {
            if let Err(e) = watcher.watch(dir, RecursiveMode::NonRecursive) {
                eprintln!("could not watch {}: {e}", dir.display());
            }
        }
        *dirs = wanted;
    }
}

/// `path` changed on disk: update the document showing it, if any.
fn changed(app: &AppHandle, path: &Path) {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let docs = app.state::<Docs>();
    let Some(label) = docs.window_for_path(&path) else {
        return;
    };
    let Some(id) = docs.for_window(&label) else {
        return;
    };
    // Gone or unreadable (mid-rename): the next event brings the new file.
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let flavor = app.state::<Store>().get().flavor;
    let outcome = docs.with(id, |open| {
        // Our own save, or a change already handled.
        if open.disk == text {
            return None;
        }
        open.disk = text.clone();
        if open.doc.is_dirty() {
            return Some(Outcome::Conflict);
        }
        let patch = open.doc.replace_text(&text, &flavor)?;
        open.doc.mark_saved(patch.version);
        Some(Outcome::Applied(patch))
    });
    match outcome.flatten() {
        Some(Outcome::Applied(patch)) => {
            let _ = app.emit_to(
                label.as_str(),
                "remote-patch",
                RemotePatchEvent { doc_id: id, patch },
            );
        }
        Some(Outcome::Conflict) => {
            let _ = app.emit_to(label.as_str(), "disk-changed", DiskChanged { doc_id: id });
        }
        None => {}
    }
}

/// Replace the document with the file on disk, dropping unsaved edits (the user chose
/// to reload). Sends the change to the window as a patch.
pub fn reload(app: &AppHandle, label: &str, id: u64) -> Result<(), String> {
    let docs = app.state::<Docs>();
    let path = docs
        .with(id, |open| open.path.clone())
        .flatten()
        .ok_or("the document has no file")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let flavor = app.state::<Store>().get().flavor;
    let patch = docs
        .with(id, |open| {
            open.disk = text.clone();
            // The dropped edits stay in their draft; new ones start another.
            open.draft = None;
            let patch = open.doc.replace_text(&text, &flavor);
            open.doc.mark_saved(open.doc.version());
            patch
        })
        .ok_or("document closed")?;
    if let Some(patch) = patch {
        let _ = app.emit_to(
            label,
            "remote-patch",
            RemotePatchEvent { doc_id: id, patch },
        );
    }
    Ok(())
}
