//! Open documents and which window shows which.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use marpora_core::Document;

pub struct OpenDoc {
    pub doc: Document,
    pub path: Option<PathBuf>,
    /// The file's text when last read or written, to tell other programs' changes
    /// from our own saves (watch.rs).
    pub disk: String,
    /// A folder opened with File › Open Folder, shown in the sidebar instead of the
    /// document's folder.
    pub folder: Option<PathBuf>,
    /// The backup of unsaved edits in `draftsRecover` (save.rs), once written.
    pub draft: Option<PathBuf>,
}

#[derive(Default)]
pub struct Docs {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    docs: HashMap<u64, OpenDoc>,
    windows: HashMap<String, u64>,
}

impl Docs {
    /// Register a document shown in window `label`, replacing the one it showed.
    /// Returns its id.
    pub fn insert(&self, label: &str, doc: OpenDoc) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.next_id += 1;
        let id = inner.next_id;
        inner.docs.insert(id, doc);
        if let Some(old) = inner.windows.insert(label.to_owned(), id) {
            inner.docs.remove(&old);
        }
        id
    }

    pub fn for_window(&self, label: &str) -> Option<u64> {
        self.inner.lock().unwrap().windows.get(label).copied()
    }

    pub fn window_for_path(&self, path: &Path) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner.windows.iter().find_map(|(label, id)| {
            let open = inner.docs.get(id)?;
            (open.path.as_deref() == Some(path)).then(|| label.clone())
        })
    }

    /// Paths of the open documents that have one.
    pub fn paths(&self) -> Vec<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner.docs.values().filter_map(|d| d.path.clone()).collect()
    }

    pub fn ids(&self) -> Vec<u64> {
        self.inner.lock().unwrap().docs.keys().copied().collect()
    }

    pub fn close_window(&self, label: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(id) = inner.windows.remove(label) {
            inner.docs.remove(&id);
        }
    }

    pub fn with<R>(&self, id: u64, f: impl FnOnce(&mut OpenDoc) -> R) -> Option<R> {
        self.inner.lock().unwrap().docs.get_mut(&id).map(f)
    }

    /// Follow a rename of `old` (a file or folder) to `new`: documents at or under it,
    /// and sidebar folders under it, move with it. Returns the windows whose document
    /// moved, with its new path.
    pub fn renamed(&self, old: &Path, new: &Path) -> Vec<(String, PathBuf)> {
        // Joining an empty rest would add a trailing slash.
        let moved = |p: &Path| {
            let rest = p.strip_prefix(old).ok()?;
            Some(match rest.as_os_str().is_empty() {
                true => new.to_path_buf(),
                false => new.join(rest),
            })
        };
        let mut inner = self.inner.lock().unwrap();
        let Inner { docs, windows, .. } = &mut *inner;
        let mut out = Vec::new();
        for (label, id) in windows.iter() {
            let Some(open) = docs.get_mut(id) else {
                continue;
            };
            if let Some(dir) = open.folder.as_deref().and_then(moved) {
                open.folder = Some(dir);
            }
            if let Some(path) = open.path.as_deref().and_then(moved) {
                open.path = Some(path.clone());
                out.push((label.clone(), path));
            }
        }
        out
    }

    /// True when no window shows a document yet (first launch).
    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap().windows.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(path: &str) -> OpenDoc {
        OpenDoc {
            doc: Document::from_markdown(""),
            path: Some(PathBuf::from(path)),
            disk: String::new(),
            folder: None,
            draft: None,
        }
    }

    #[test]
    fn renames_follow_files_and_folders() {
        let docs = Docs::default();
        docs.insert("a", open("/n/Untitled.md"));
        docs.insert("b", open("/n/sub/x.md"));
        docs.insert("c", open("/n/Untitled.md.bak"));
        let moved = docs.renamed(Path::new("/n/Untitled.md"), Path::new("/n/Plan.md"));
        assert_eq!(moved, [("a".to_owned(), PathBuf::from("/n/Plan.md"))]);
        let moved = docs.renamed(Path::new("/n/sub"), Path::new("/n/docs"));
        assert_eq!(moved, [("b".to_owned(), PathBuf::from("/n/docs/x.md"))]);
    }
}
