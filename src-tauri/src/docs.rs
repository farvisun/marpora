//! Open documents and which window shows which.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use marpora_core::Document;

pub struct OpenDoc {
    pub doc: Document,
    pub path: Option<PathBuf>,
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
    /// Register a document shown in window `label`. Returns its id.
    pub fn insert(&self, label: &str, doc: OpenDoc) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.next_id += 1;
        let id = inner.next_id;
        inner.docs.insert(id, doc);
        inner.windows.insert(label.to_owned(), id);
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

    pub fn close_window(&self, label: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(id) = inner.windows.remove(label) {
            inner.docs.remove(&id);
        }
    }

    pub fn with<R>(&self, id: u64, f: impl FnOnce(&mut OpenDoc) -> R) -> Option<R> {
        self.inner.lock().unwrap().docs.get_mut(&id).map(f)
    }

    /// True when no window shows a document yet (first launch).
    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap().windows.is_empty()
    }
}
