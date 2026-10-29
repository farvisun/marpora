//! Find in files, the sidebar's Search, with ripgrep's libraries and the options Typora
//! passes to `rg`: Markdown files under the library folder, without hidden files
//! (unless they are shown), git-ignored files, `node_modules`, binary files and files
//! over 2 MB, and at most 21 matching lines per file. Without a regular expression,
//! files whose name matches are listed too.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::library::is_markdown;

/// Matching lines kept per file (`rg -m 21`).
const MAX_LINES: usize = 21;
/// Larger files are skipped (`rg --max-filesize 2M`).
const MAX_FILESIZE: u64 = 2 * 1024 * 1024;
/// Files listed at most; the rest are left out.
const MAX_FILES: usize = 1000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub text: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regexp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Results {
    pub files: Vec<FileHit>,
    /// The query is not a valid regular expression.
    pub error: Option<String>,
    /// More files matched than were listed.
    pub more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    /// Matches in the lines found (0 when only the name matched).
    pub total: usize,
    pub lines: Vec<LineHit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHit {
    /// Zero-based.
    pub line: u64,
    pub text: String,
    /// Matches in `text`, in UTF-16 code units for the page.
    pub ranges: Vec<[usize; 2]>,
}

/// The number of the newest search; older ones stop when they see a newer one.
#[derive(Default)]
pub struct Searches(AtomicU64);

impl Searches {
    pub fn start(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub fn matcher(q: &Query) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(!q.case_sensitive)
        .word(q.whole_word)
        .fixed_strings(!q.regexp)
        .line_terminator(Some(b'\n'))
        .build(&q.text)
        .map_err(|e| e.to_string())
}

/// Search the Markdown files under `root`; `hidden` includes dot files. Stops early
/// once `cancelled` returns true.
pub fn search(root: &Path, q: &Query, hidden: bool, cancelled: impl Fn() -> bool) -> Results {
    let mut results = Results {
        files: Vec::new(),
        error: None,
        more: false,
    };
    let matcher = match matcher(q) {
        Ok(m) => m,
        Err(e) => {
            results.error = Some(e);
            return results;
        }
    };
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(0))
        .build();
    let walk = WalkBuilder::new(root)
        .hidden(!hidden)
        .max_filesize(Some(MAX_FILESIZE))
        .filter_entry(|e| e.file_name() != "node_modules")
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    for entry in walk.flatten() {
        if cancelled() {
            break;
        }
        let path = entry.path();
        if !entry.file_type().is_some_and(|t| t.is_file()) || !is_markdown(path) {
            continue;
        }
        let mut sink = Collect {
            matcher: &matcher,
            lines: Vec::new(),
            total: 0,
        };
        if searcher.search_path(&matcher, path, &mut sink).is_err() {
            continue;
        }
        if sink.lines.is_empty() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if q.regexp || !matcher.is_match(name.as_bytes()).unwrap_or(false) {
                continue;
            }
            sink.lines.extend(first_line(path));
        }
        if results.files.len() == MAX_FILES {
            results.more = true;
            break;
        }
        results.files.push(FileHit {
            path: path.to_string_lossy().into_owned(),
            total: sink.total,
            lines: sink.lines,
        });
    }
    results
}

/// The first line of a file whose name matched, shown without highlights.
fn first_line(path: &Path) -> Option<LineHit> {
    use std::io::{BufRead, BufReader};
    let mut line = String::new();
    BufReader::new(std::fs::File::open(path).ok()?)
        .read_line(&mut line)
        .ok()?;
    Some(LineHit {
        line: 0,
        text: line.trim_end_matches(['\r', '\n']).to_owned(),
        ranges: Vec::new(),
    })
}

struct Collect<'a> {
    matcher: &'a RegexMatcher,
    lines: Vec<LineHit>,
    total: usize,
}

impl Sink for Collect<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, m: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let bytes = m.bytes();
        let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
        let mut found = Vec::new();
        let _ = self.matcher.find_iter(bytes, |r| {
            found.push((r.start(), r.end()));
            true
        });
        self.total += found.len().max(1);
        let text = String::from_utf8_lossy(bytes).into_owned();
        let utf16 = |byte: usize| {
            let byte = byte.min(text.len());
            let byte = (0..=byte)
                .rev()
                .find(|&b| text.is_char_boundary(b))
                .unwrap_or(0);
            text[..byte].encode_utf16().count()
        };
        let ranges = found.iter().map(|&(s, e)| [utf16(s), utf16(e)]).collect();
        self.lines.push(LineHit {
            line: m.line_number().unwrap_or(1).saturating_sub(1),
            text,
            ranges,
        });
        Ok(self.lines.len() < MAX_LINES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(text: &str) -> Query {
        Query {
            text: text.to_owned(),
            case_sensitive: false,
            whole_word: false,
            regexp: false,
        }
    }

    #[test]
    fn finds_lines_and_names() {
        let dir = std::env::temp_dir().join(format!("marpora-search-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join("a.md"), "one Apple\nnone\nan apple, two apples\n").unwrap();
        std::fs::write(dir.join("sub/apple pie.md"), "Recipe\nflour\n").unwrap();
        std::fs::write(dir.join("b.txt.png"), "apple").unwrap();
        std::fs::write(dir.join(".hidden/c.md"), "apple").unwrap();
        std::fs::write(dir.join("é.md"), "café apple").unwrap();

        let r = search(&dir, &query("apple"), false, || false);
        let names: Vec<_> = r
            .files
            .iter()
            .map(|f| f.path.strip_prefix(dir.to_str().unwrap()).unwrap())
            .collect();
        assert_eq!(names, ["/a.md", "/sub/apple pie.md", "/é.md"]);
        let a = &r.files[0];
        assert_eq!(a.total, 3);
        assert_eq!(a.lines.iter().map(|l| l.line).collect::<Vec<_>>(), [0, 2]);
        assert_eq!(a.lines[1].ranges, [[3, 8], [14, 19]]);
        assert_eq!(r.files[1].total, 0, "name only");
        assert_eq!(r.files[1].lines[0].text, "Recipe");
        assert_eq!(r.files[2].lines[0].ranges, [[5, 10]], "UTF-16 offsets");

        let mut q = query("Apple");
        q.case_sensitive = true;
        q.whole_word = true;
        assert_eq!(search(&dir, &q, false, || false).files.len(), 1);
        assert_eq!(
            search(&dir, &query("apple"), true, || false).files.len(),
            4,
            "hidden"
        );
        q.regexp = true;
        q.text = "(".into();
        assert!(search(&dir, &q, false, || false).error.is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
