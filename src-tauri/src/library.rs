//! The file library behind the sidebar's Files tab and Quick Open: the folder a window
//! shows (its document's folder), listed one level at a time for the tree or walked
//! for the article list, plus the recently opened files.
//!
//! Like Typora, hidden entries (`.name`) and `node_modules` are skipped.

use std::collections::VecDeque;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The article list stops here and asks for the tree instead, like Typora.
pub const MAX_LIST: usize = 400;
/// Quick Open searches at most this many files.
pub const MAX_QUICK_OPEN: usize = 10_000;
/// Bytes read for a file's summary in the article list.
const SUMMARY_BYTES: usize = 600;
const MAX_RECENT: usize = 20;

const EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdown", "mdwn", "mkd", "mkdn", "mdtxt", "mdtext", "mmd", "text", "txt",
    "rmd", "qmd",
];

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

fn is_ignored(name: &str) -> bool {
    name == "node_modules" || (name.starts_with('.') && name.len() > 1)
}

/// A file or folder in the tree.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    /// Folders: whether they hold anything the tree shows.
    pub has_children: bool,
    /// Milliseconds since the epoch.
    pub modified: f64,
    pub created: f64,
}

/// A Markdown file in the article list or Quick Open.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub name: String,
    pub path: String,
    pub folder: String,
    pub modified: f64,
    pub created: f64,
    /// The start of the file, for the list's summary; empty for Quick Open.
    pub summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Docs {
    pub files: Vec<Doc>,
    /// The folder holds more files than were listed.
    pub oversize: bool,
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// What the tree shows in `dir`: folders and Markdown files, unsorted.
fn shown(dir: &Path) -> impl Iterator<Item = (PathBuf, String, Metadata)> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_ignored(&name) {
                return None;
            }
            let path = e.path();
            // Follows symlinks, so a linked folder lists like a folder.
            let meta = std::fs::metadata(&path).ok()?;
            (meta.is_dir() || (meta.is_file() && is_markdown(&path))).then_some((path, name, meta))
        })
}

/// One level of the tree.
pub fn list_dir(dir: &Path) -> Vec<Entry> {
    shown(dir)
        .map(|(path, name, meta)| Entry {
            has_children: meta.is_dir() && shown(&path).next().is_some(),
            is_directory: meta.is_dir(),
            modified: millis(meta.modified()),
            created: millis(meta.created()),
            path: path.to_string_lossy().into_owned(),
            name,
        })
        .collect()
}

/// Markdown files under `root`, breadth first, at most `limit`. With `summaries`, each
/// carries the start of its text.
pub fn walk(root: &Path, limit: usize, summaries: bool) -> Docs {
    let mut files = Vec::new();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let mut entries: Vec<_> = shown(&dir).collect();
        entries.sort_by(|a, b| a.1.cmp(&b.1));
        for (path, name, meta) in entries {
            if meta.is_dir() {
                queue.push_back(path);
                continue;
            }
            if files.len() == limit {
                return Docs {
                    files,
                    oversize: true,
                };
            }
            files.push(Doc {
                summary: if summaries {
                    summary(&path)
                } else {
                    String::new()
                },
                folder: dir.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                modified: millis(meta.modified()),
                created: millis(meta.created()),
                name,
            });
        }
    }
    Docs {
        files,
        oversize: false,
    }
}

/// The first `SUMMARY_BYTES` of a file, cut back to whole characters.
fn summary(path: &Path) -> String {
    use std::io::Read;
    let mut buf = Vec::with_capacity(SUMMARY_BYTES);
    let read =
        std::fs::File::open(path).and_then(|f| f.take(SUMMARY_BYTES as u64).read_to_end(&mut buf));
    if read.is_err() {
        return String::new();
    }
    match std::str::from_utf8(&buf) {
        Ok(s) => s.to_owned(),
        Err(e) if e.error_len().is_none() => {
            String::from_utf8_lossy(&buf[..e.valid_up_to()]).into_owned()
        }
        Err(_) => String::from_utf8_lossy(&buf).into_owned(),
    }
}

/// Whether `path` is `root` or inside it.
pub fn contains(root: &Path, path: &Path) -> bool {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path.starts_with(root)
}

/// Recently opened and saved files, newest first, kept in the app config directory.
pub struct Recent {
    path: Option<PathBuf>,
    files: Mutex<Vec<String>>,
}

impl Recent {
    pub fn load(app: &AppHandle) -> Self {
        let path = app
            .path()
            .app_config_dir()
            .ok()
            .map(|d| d.join("recent.json"));
        let files = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Recent {
            path,
            files: Mutex::new(files),
        }
    }

    /// The recent files that still exist.
    pub fn files(&self) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .iter()
            .filter(|p| Path::new(p).is_file())
            .cloned()
            .collect()
    }

    pub fn add(&self, file: &Path) {
        let files = {
            let mut files = self.files.lock().unwrap();
            push_recent(&mut files, file.to_string_lossy().into_owned());
            files.clone()
        };
        let Some(path) = &self.path else { return };
        let saved = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(path, serde_json::to_string_pretty(&files)?));
        if let Err(e) = saved {
            eprintln!("could not save recent files to {}: {e}", path.display());
        }
    }
}

fn push_recent(files: &mut Vec<String>, file: String) {
    files.retain(|f| *f != file);
    files.insert(0, file);
    files.truncate(MAX_RECENT);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("marpora-library-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn lists_folders_and_markdown_skipping_hidden() {
        let dir = temp_dir("list");
        touch(&dir.join("a.md"), "# A");
        touch(&dir.join("b.png"), "");
        touch(&dir.join(".hidden/c.md"), "");
        touch(&dir.join("node_modules/d.md"), "");
        touch(&dir.join("notes/e.markdown"), "");
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        let mut entries = list_dir(&dir);
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<_> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_directory, e.has_children))
            .collect();
        assert_eq!(
            names,
            [
                ("a.md", false, false),
                ("empty", true, false),
                ("notes", true, true)
            ]
        );
    }

    #[test]
    fn walks_breadth_first_with_summaries_and_a_limit() {
        let dir = temp_dir("walk");
        touch(&dir.join("z.md"), "zed");
        touch(&dir.join("sub/a.md"), "deep");
        touch(&dir.join("b.md"), &format!("a{}", "é".repeat(400)));
        let docs = walk(&dir, 10, true);
        let names: Vec<_> = docs.files.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["b.md", "z.md", "a.md"]);
        assert!(!docs.oversize);
        // 600 bytes end inside a two-byte character, which is dropped.
        assert_eq!(docs.files[0].summary.chars().count(), 300);
        assert_eq!(docs.files[2].folder, dir.join("sub").to_string_lossy());

        let docs = walk(&dir, 2, false);
        assert_eq!(docs.files.len(), 2);
        assert!(docs.oversize);
        assert_eq!(docs.files[0].summary, "");
    }

    #[test]
    fn recent_files_move_to_the_front() {
        let mut files = vec!["a".to_owned(), "b".to_owned()];
        push_recent(&mut files, "b".to_owned());
        push_recent(&mut files, "c".to_owned());
        assert_eq!(files, ["c", "b", "a"]);
    }
}
