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

/// `node_modules` is never listed; dot files only when `hidden` is set.
fn is_ignored(name: &str, hidden: bool) -> bool {
    name == "node_modules" || (!hidden && name.starts_with('.') && name.len() > 1)
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
fn shown(dir: &Path, hidden: bool) -> impl Iterator<Item = (PathBuf, String, Metadata)> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(move |e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_ignored(&name, hidden) {
                return None;
            }
            let path = e.path();
            // Follows symlinks, so a linked folder lists like a folder.
            let meta = std::fs::metadata(&path).ok()?;
            (meta.is_dir() || (meta.is_file() && is_markdown(&path))).then_some((path, name, meta))
        })
}

/// One level of the tree. With `hidden`, dot files are listed too.
pub fn list_dir(dir: &Path, hidden: bool) -> Vec<Entry> {
    shown(dir, hidden)
        .map(|(path, name, meta)| Entry {
            has_children: meta.is_dir() && shown(&path, hidden).next().is_some(),
            is_directory: meta.is_dir(),
            modified: millis(meta.modified()),
            created: millis(meta.created()),
            path: path.to_string_lossy().into_owned(),
            name,
        })
        .collect()
}

/// Markdown files under `root`, breadth first, at most `limit`. With `summaries`, each
/// carries the start of its text; with `hidden`, dot files are included.
pub fn walk(root: &Path, limit: usize, summaries: bool, hidden: bool) -> Docs {
    let mut files = Vec::new();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let mut entries: Vec<_> = shown(&dir, hidden).collect();
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

/// Recently opened and saved files and opened folders, newest first, kept in the app
/// config directory.
pub struct Recent {
    files: RecentList,
    folders: RecentList,
    /// Folders pinned to the top of Recent Locations; they never age out.
    pinned: RecentList,
}

/// A folder in the sidebar menu's Recent Locations.
#[derive(serde::Serialize)]
pub struct RecentFolder {
    pub path: String,
    pub pinned: bool,
}

struct RecentList {
    path: Option<PathBuf>,
    items: Mutex<Vec<String>>,
}

impl RecentList {
    fn load(path: Option<PathBuf>) -> Self {
        let items = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        RecentList {
            path,
            items: Mutex::new(items),
        }
    }

    fn existing(&self, keep: impl Fn(&Path) -> bool) -> Vec<String> {
        let items = self.items.lock().unwrap();
        items
            .iter()
            .filter(|p| keep(Path::new(p)))
            .cloned()
            .collect()
    }

    fn add(&self, item: &Path) {
        let mut items = self.items.lock().unwrap();
        push_recent(&mut items, item.to_string_lossy().into_owned());
        self.save(&items);
    }

    fn remove(&self, item: &str) {
        let mut items = self.items.lock().unwrap();
        items.retain(|i| i != item);
        self.save(&items);
    }

    fn clear(&self) {
        let mut items = self.items.lock().unwrap();
        items.clear();
        self.save(&items);
    }

    fn save(&self, items: &[String]) {
        let Some(path) = &self.path else { return };
        let saved = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(path, serde_json::to_string_pretty(items)?));
        if let Err(e) = saved {
            eprintln!("could not save recent items to {}: {e}", path.display());
        }
    }
}

impl Recent {
    pub fn load(app: &AppHandle) -> Self {
        let dir = app.path().app_config_dir().ok();
        Recent {
            files: RecentList::load(dir.as_ref().map(|d| d.join("recent.json"))),
            folders: RecentList::load(dir.as_ref().map(|d| d.join("recent-folders.json"))),
            pinned: RecentList::load(dir.as_ref().map(|d| d.join("pinned-folders.json"))),
        }
    }

    /// The recent files that still exist.
    pub fn files(&self) -> Vec<String> {
        self.files.existing(Path::is_file)
    }

    /// The recent folders that still exist (the sidebar menu's Recent Locations):
    /// the pinned ones first, as Typora lists them.
    pub fn folders(&self) -> Vec<RecentFolder> {
        let pinned = self.pinned.existing(Path::is_dir);
        let recent = self
            .folders
            .existing(|p| p.is_dir() && !pinned.iter().any(|q| Path::new(q) == p));
        let entry = |pinned| move |path| RecentFolder { path, pinned };
        pinned
            .into_iter()
            .map(entry(true))
            .chain(recent.into_iter().map(entry(false)))
            .collect()
    }

    /// Pin `dir` to the top of Recent Locations, or unpin it (it stays recent).
    pub fn pin_folder(&self, dir: &Path, pinned: bool) {
        if pinned {
            self.pinned.add(dir);
        } else {
            self.pinned.remove(&dir.to_string_lossy());
            self.folders.add(dir);
        }
    }

    /// Remove `dir` from Recent Locations.
    pub fn remove_folder(&self, dir: &Path) {
        let dir = dir.to_string_lossy();
        self.pinned.remove(&dir);
        self.folders.remove(&dir);
    }

    pub fn add(&self, file: &Path) {
        self.files.add(file);
    }

    /// Clear files and folders, like Typora's "Clear Recent Folders and Files".
    pub fn clear(&self) {
        self.files.clear();
        self.folders.clear();
        self.pinned.clear();
    }
}

/// Add `file` to the recent files and to File › Open Recent.
pub fn remember(app: &AppHandle, file: &Path) {
    if !app.state::<crate::settings::Store>().get().record_recent {
        return;
    }
    app.state::<Recent>().add(file);
    crate::menu::refresh_recent(app);
}

/// Add `dir` to the recent folders.
pub fn remember_folder(app: &AppHandle, dir: &Path) {
    if app.state::<crate::settings::Store>().get().record_recent {
        app.state::<Recent>().folders.add(dir);
    }
}

/// A file name typed into the sidebar, as Typora takes it on macOS: without slashes
/// (and here control characters), trimmed. None when nothing usable is left.
pub fn clean_file_name(name: &str) -> Option<String> {
    let name: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\') && !c.is_control())
        .collect();
    let name = name.trim();
    (!name.is_empty() && name != "." && name != "..").then(|| name.to_owned())
}

/// A free name for a new file in `dir`: `Untitled.md`, else one past the highest
/// `Untitled N.md`, as Typora numbers them.
pub fn untitled_name(dir: &Path) -> String {
    let next = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            let rest = name.strip_prefix("untitled")?;
            let number = rest.split('.').next()?;
            if !rest.contains('.') {
                return None;
            }
            match number.strip_prefix(' ') {
                None if number.is_empty() => Some(1),
                Some(n) => n.parse::<u32>().ok().map(|n| n + 1),
                None => None,
            }
        })
        .max()
        .unwrap_or(0);
    if next == 0 {
        "Untitled.md".to_owned()
    } else {
        format!("Untitled {next}.md")
    }
}

/// A free name for a new folder in `dir`: `Untitled Folder`, else one past the highest
/// `Untitled Folder N`, as Typora numbers them.
pub fn untitled_folder_name(dir: &Path) -> String {
    let next = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            match name.strip_prefix("untitled folder")? {
                "" => Some(1),
                rest => rest.strip_prefix(' ')?.parse::<u32>().ok().map(|n| n + 1),
            }
        })
        .max()
        .unwrap_or(0);
    if next == 0 {
        "Untitled Folder".to_owned()
    } else {
        format!("Untitled Folder {next}")
    }
}

/// The name for a copy of `name` in a folder holding `taken`: `a (copy).md`, then
/// `a (copy) (copy).md`, as Typora's Duplicate names them.
pub fn copy_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    let (mut stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (name[..dot].to_owned(), &name[dot..]),
        _ => (name.to_owned(), ""),
    };
    loop {
        stem.push_str(" (copy)");
        let candidate = format!("{stem}{ext}");
        if !taken(&candidate) {
            return candidate;
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

    fn basename(p: &str) -> &str {
        p.rsplit('/').next().unwrap_or(p)
    }

    #[test]
    fn pinned_folders_come_first_and_stay() {
        let root = temp_dir("pinned");
        let [a, b, c] = ["a", "b", "c"].map(|n| {
            let d = root.join(n);
            std::fs::create_dir_all(&d).unwrap();
            d
        });
        let recent = Recent {
            files: RecentList::load(None),
            folders: RecentList::load(None),
            pinned: RecentList::load(None),
        };
        for d in [&a, &b, &c] {
            recent.folders.add(d);
        }
        let list = |r: &Recent| {
            r.folders()
                .into_iter()
                .map(|f| format!("{}{}", basename(&f.path), if f.pinned { "*" } else { "" }))
                .collect::<Vec<_>>()
                .join(",")
        };
        assert_eq!(list(&recent), "c,b,a");
        recent.pin_folder(&a, true);
        assert_eq!(list(&recent), "a*,c,b");
        recent.pin_folder(&a, false);
        assert_eq!(list(&recent), "a,c,b");
        recent.pin_folder(&b, true);
        recent.remove_folder(&b);
        recent.remove_folder(&c);
        assert_eq!(list(&recent), "a");
        let _ = std::fs::remove_dir_all(&root);
    }

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
        let mut entries = list_dir(&dir, false);
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
        // Preferences › Show hidden folders / files; node_modules stays out.
        let hidden: Vec<_> = list_dir(&dir, true).into_iter().map(|e| e.name).collect();
        assert!(hidden.contains(&".hidden".to_owned()));
        assert!(!hidden.contains(&"node_modules".to_owned()));
        assert_eq!(walk(&dir, 10, false, true).files.len(), 3);
    }

    #[test]
    fn walks_breadth_first_with_summaries_and_a_limit() {
        let dir = temp_dir("walk");
        touch(&dir.join("z.md"), "zed");
        touch(&dir.join("sub/a.md"), "deep");
        touch(&dir.join("b.md"), &format!("a{}", "é".repeat(400)));
        let docs = walk(&dir, 10, true, false);
        let names: Vec<_> = docs.files.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["b.md", "z.md", "a.md"]);
        assert!(!docs.oversize);
        // 600 bytes end inside a two-byte character, which is dropped.
        assert_eq!(docs.files[0].summary.chars().count(), 300);
        assert_eq!(docs.files[2].folder, dir.join("sub").to_string_lossy());

        let docs = walk(&dir, 2, false, false);
        assert_eq!(docs.files.len(), 2);
        assert!(docs.oversize);
        assert_eq!(docs.files[0].summary, "");
    }

    #[test]
    fn file_names_are_cleaned() {
        assert_eq!(clean_file_name(" a/b\\c.md \n").as_deref(), Some("abc.md"));
        assert_eq!(clean_file_name(" / "), None);
        assert_eq!(clean_file_name(".."), None);
    }

    #[test]
    fn untitled_names_count_up() {
        let dir = temp_dir("untitled");
        assert_eq!(untitled_name(&dir), "Untitled.md");
        touch(&dir.join("Untitled.md"), "");
        assert_eq!(untitled_name(&dir), "Untitled 1.md");
        touch(&dir.join("untitled 4.markdown"), "");
        touch(&dir.join("Untitled notes.md"), "");
        assert_eq!(untitled_name(&dir), "Untitled 5.md");
    }

    #[test]
    fn untitled_folders_count_up() {
        let dir = temp_dir("untitled-folder");
        assert_eq!(untitled_folder_name(&dir), "Untitled Folder");
        std::fs::create_dir_all(dir.join("Untitled Folder")).unwrap();
        assert_eq!(untitled_folder_name(&dir), "Untitled Folder 1");
        std::fs::create_dir_all(dir.join("untitled folder 3")).unwrap();
        touch(&dir.join("Untitled Folder 9"), "");
        assert_eq!(untitled_folder_name(&dir), "Untitled Folder 4");
    }

    #[test]
    fn copies_are_named_like_typora() {
        assert_eq!(copy_name("a.md", |_| false), "a (copy).md");
        assert_eq!(
            copy_name("a.md", |n| n == "a (copy).md"),
            "a (copy) (copy).md"
        );
        assert_eq!(copy_name(".env", |_| false), ".env (copy)");
    }

    #[test]
    fn recent_files_move_to_the_front() {
        let mut files = vec!["a".to_owned(), "b".to_owned()];
        push_recent(&mut files, "b".to_owned());
        push_recent(&mut files, "c".to_owned());
        assert_eq!(files, ["c", "b", "a"]);
    }
}
