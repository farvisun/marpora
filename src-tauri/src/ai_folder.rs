//! The AI chat's tools over the sidebar's folder (marpora_llm::folder_tools): search,
//! list, read and outline its Markdown files, never anything outside it. Each call is
//! shown in the chat as it happens.

use std::path::{Path, PathBuf};

use marpora_llm::{FolderTools, string_arg};
use serde_json::Value;

use crate::library;
use crate::search::{self, Query};

/// What a file read gives the model at most.
const READ_LIMIT: usize = 200_000;
const SEARCH_FILES: usize = 30;
const SEARCH_LINES: usize = 6;
const LIST_LIMIT: usize = 500;

pub struct Folder {
    root: PathBuf,
    /// Told what each call does, for the chat to show.
    on_call: Box<dyn Fn(String) + Send + Sync>,
}

impl Folder {
    pub fn new(root: PathBuf, on_call: impl Fn(String) + Send + Sync + 'static) -> Self {
        let root = std::fs::canonicalize(&root).unwrap_or(root);
        Self {
            root,
            on_call: Box::new(on_call),
        }
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    }

    /// The Markdown file at `path` (relative to the folder), when it is inside it.
    fn file(&self, path: &str) -> Result<PathBuf, String> {
        let joined = self.root.join(path.trim_start_matches('/'));
        let file = std::fs::canonicalize(&joined).map_err(|_| {
            format!("{path} does not exist in the folder; list_files shows what does")
        })?;
        if !file.starts_with(&self.root) {
            return Err(format!("{path} is outside the folder"));
        }
        if !file.is_file() || !library::is_markdown(&file) {
            return Err(format!("{path} is not a Markdown file"));
        }
        Ok(file)
    }

    fn read(&self, path: &str) -> Result<String, String> {
        let file = self.file(path)?;
        let text =
            std::fs::read_to_string(&file).map_err(|e| format!("could not read {path}: {e}"))?;
        Ok(match text.char_indices().nth(READ_LIMIT) {
            Some((cut, _)) => format!(
                "{}\n\n[The file goes on; this is its first part.]",
                &text[..cut]
            ),
            None => text,
        })
    }

    fn search(&self, query: &str) -> String {
        let q = Query {
            text: query.to_owned(),
            case_sensitive: false,
            whole_word: false,
            regexp: false,
        };
        let results = search::search(&self.root, &q, false, || false);
        if results.files.is_empty() {
            return format!("No file mentions “{query}”.");
        }
        let mut out = String::new();
        for hit in results.files.iter().take(SEARCH_FILES) {
            out.push_str(&self.relative(Path::new(&hit.path)));
            out.push('\n');
            for line in hit.lines.iter().take(SEARCH_LINES) {
                out.push_str(&format!("  {}: {}\n", line.line + 1, line.text.trim()));
            }
        }
        if results.files.len() > SEARCH_FILES || results.more {
            out.push_str("[More files match; search for something narrower.]\n");
        }
        out
    }

    fn list(&self) -> String {
        let mut docs = library::walk(&self.root, LIST_LIMIT, false, false);
        docs.files.sort_by(|a, b| b.modified.total_cmp(&a.modified));
        let mut out: Vec<String> = docs
            .files
            .iter()
            .map(|d| self.relative(Path::new(&d.path)))
            .collect();
        if out.is_empty() {
            return "The folder has no Markdown files.".into();
        }
        if docs.oversize {
            out.push(format!("[The first {LIST_LIMIT} files only.]"));
        }
        out.join("\n")
    }

    fn outline(&self, path: &str) -> Result<String, String> {
        let text = std::fs::read_to_string(self.file(path)?)
            .map_err(|e| format!("could not read {path}: {e}"))?;
        let headings = outline(&text);
        Ok(match headings.is_empty() {
            true => format!("{path} has no headings."),
            false => headings.join("\n"),
        })
    }
}

/// The ATX headings of `markdown` outside code fences, as `line: ## Title`.
pub fn outline(markdown: &str) -> Vec<String> {
    let mut fence: Option<&str> = None;
    let mut out = Vec::new();
    for (i, line) in markdown.lines().enumerate() {
        let trimmed = line.trim_start();
        let marker = ["```", "~~~"].into_iter().find(|m| trimmed.starts_with(m));
        match (fence, marker) {
            (None, Some(m)) => fence = Some(m),
            (Some(f), Some(m)) if f == m => fence = None,
            _ => {}
        }
        if fence.is_some() || marker.is_some() {
            continue;
        }
        let level = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level) && trimmed[level..].starts_with([' ', '\t']) {
            out.push(format!(
                "{}: {} {}",
                i + 1,
                "#".repeat(level),
                trimmed[level..].trim().trim_end_matches('#').trim()
            ));
        }
    }
    out
}

impl FolderTools for Folder {
    fn root(&self) -> &Path {
        &self.root
    }

    fn call(&self, name: &str, input: &Value) -> Result<String, String> {
        match name {
            "search_files" => {
                let query = string_arg(input, "query")?;
                (self.on_call)(format!("Searching for “{query}”"));
                Ok(self.search(query))
            }
            "list_files" => {
                (self.on_call)("Listing files".into());
                Ok(self.list())
            }
            "read_file" => {
                let path = string_arg(input, "path")?;
                (self.on_call)(format!("Reading {path}"));
                self.read(path)
            }
            "get_outline" => {
                let path = string_arg(input, "path")?;
                (self.on_call)(format!("Outlining {path}"));
                self.outline(path)
            }
            _ => Err(format!("there is no tool {name}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn outlines_skip_code() {
        assert_eq!(
            outline("# One\ntext\n```\n# not\n```\n## Two ##\n#nope\n"),
            ["1: # One", "6: ## Two"]
        );
    }

    #[test]
    fn tools_stay_in_the_folder() {
        let base = std::env::temp_dir().join(format!("marpora-ai-folder-{}", std::process::id()));
        let root = base.join("notes");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("todo.md"), "# Todo\n\nBuy milk\n").unwrap();
        std::fs::write(root.join("sub/plan.md"), "## Plan\n\nMilk run on Friday\n").unwrap();
        std::fs::write(base.join("secret.md"), "outside").unwrap();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = calls.clone();
        let folder = Folder::new(root.clone(), move |c| seen.lock().unwrap().push(c));

        let found = folder
            .call("search_files", &json!({ "query": "milk" }))
            .unwrap();
        let read = folder
            .call("read_file", &json!({ "path": "sub/plan.md" }))
            .unwrap();
        let outside = folder.call("read_file", &json!({ "path": "../secret.md" }));
        let missing = folder.call("read_file", &json!({}));
        let listed = folder.call("list_files", &json!({})).unwrap();
        std::fs::remove_dir_all(&base).unwrap();

        assert!(
            found.contains("todo.md\n  3: Buy milk")
                && found.contains("sub/plan.md\n  3: Milk run on Friday"),
            "{found}"
        );
        assert_eq!(read, "## Plan\n\nMilk run on Friday\n");
        assert!(outside.unwrap_err().contains("outside the folder"));
        assert!(missing.unwrap_err().contains("path is required"));
        assert!(listed.contains("todo.md") && listed.contains("sub/plan.md"));
        assert_eq!(calls.lock().unwrap()[0], "Searching for “milk”");
    }
}
