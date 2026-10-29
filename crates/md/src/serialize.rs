//! ProseMirror JSON → Markdown.
//!
//! Only blocks the user changed are ever serialized (untouched blocks keep their
//! original bytes, see `marpora-core`), so the goal here is output that re-parses to
//! the same document while keeping the style recorded in node attrs (bullet char,
//! emphasis delimiter, fence, setext headings).

use unicode_width::UnicodeWidthStr;

use crate::pm::{self, MARK_ORDER, Mark, Node};

/// Separator between top-level blocks written by the editor.
pub const BLOCK_SEP: &str = "\n\n";

pub fn serialize_doc(doc: &Node) -> String {
    let mut out = doc
        .content
        .iter()
        .map(serialize_block)
        .collect::<Vec<_>>()
        .join(BLOCK_SEP);
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/// One block, without a trailing newline.
pub fn serialize_block(node: &Node) -> String {
    match node.kind.as_str() {
        "paragraph" => inlines(&node.content, false),
        "heading" => heading(node),
        "blockquote" => prefix_lines(&blocks(&node.content, BLOCK_SEP), "> ", "> "),
        "bullet_list" | "ordered_list" => list(node),
        "code_block" => code_block(node),
        "math_block" => format!("$$\n{}\n$$", node.text_content()),
        "html_block" | "raw_block" => node.text_content(),
        "horizontal_rule" => node.attr_str("markup").unwrap_or("---").to_owned(),
        "table" => table(node),
        "front_matter" => {
            let body = node.text_content();
            if body.is_empty() {
                "---\n---".to_owned()
            } else {
                format!("---\n{body}\n---")
            }
        }
        "footnote_def" => {
            let label = node.attr_str("label").unwrap_or("");
            let body = blocks(&node.content, BLOCK_SEP);
            prefix_lines(&body, &format!("[^{label}]: "), "    ")
        }
        "toc" => "[TOC]".to_owned(),
        // Unknown blocks degrade to their text rather than vanishing.
        _ => node.text_content(),
    }
}

fn blocks(nodes: &[Node], sep: &str) -> String {
    nodes
        .iter()
        .map(serialize_block)
        .collect::<Vec<_>>()
        .join(sep)
}

/// Prefix the first line with `first` and every other line with `rest`.
/// Blank lines only get the non-whitespace part of the prefix.
fn prefix_lines(text: &str, first: &str, rest: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let prefix = if i == 0 { first } else { rest };
        if line.is_empty() {
            out.push_str(prefix.trim_end());
        } else {
            out.push_str(prefix);
            out.push_str(line);
        }
    }
    out
}

fn heading(node: &Node) -> String {
    let level = node.attr_u64("level").unwrap_or(1).clamp(1, 6) as usize;
    let mut text = inlines(&node.content, false);
    if node.attr_bool("setext") == Some(true) && level <= 2 && !text.is_empty() {
        let width = text
            .lines()
            .map(UnicodeWidthStr::width)
            .max()
            .unwrap_or(0)
            .max(3);
        let ch = if level == 1 { "=" } else { "-" };
        return format!("{text}\n{}", ch.repeat(width));
    }
    // A trailing run of `#` would be read as the closing sequence.
    if text.ends_with('#') {
        text.insert(text.len() - 1, '\\');
    }
    let hashes = "#".repeat(level);
    if text.is_empty() {
        hashes
    } else {
        format!("{hashes} {}", text.replace('\n', " "))
    }
}

fn list(node: &Node) -> String {
    let ordered = node.kind == "ordered_list";
    let tight = node.attr_bool("tight").unwrap_or(true);
    let sep = if tight { "\n" } else { "\n\n" };
    let bullet = node.attr_str("bullet").unwrap_or("-");
    let delim = node.attr_str("delim").unwrap_or(".");
    let start = node.attr_u64("start").unwrap_or(1);

    let items: Vec<String> = node
        .content
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let marker = if ordered {
                format!("{}{delim} ", start + i as u64)
            } else {
                format!("{bullet} ")
            };
            let indent = " ".repeat(marker.len());
            let task = match item.attrs.get("checked").and_then(|v| v.as_bool()) {
                Some(true) => "[x] ",
                Some(false) => "[ ] ",
                None => "",
            };
            let body = blocks(&item.content, sep);
            let body = prefix_lines(&body, &format!("{marker}{task}"), &indent);
            // An empty task item still needs the space after `]`.
            if body.trim_end().ends_with(']') && !task.is_empty() {
                body
            } else {
                body.trim_end().to_owned()
            }
        })
        .collect();
    items.join(sep)
}

fn code_block(node: &Node) -> String {
    let code = node.text_content();
    let info = node.attr_str("info").unwrap_or("");
    let fence = node.attr_str("fence").unwrap_or("```");
    if fence.is_empty() && info.is_empty() && !code.trim().is_empty() {
        return prefix_lines(&code, "    ", "    ");
    }
    // Info strings are unescaped on parse, and cannot contain backticks after ```.
    let info = &info.replace('\\', "\\\\").replace('&', "\\&");
    let ch = if fence.starts_with('~') || info.contains('`') {
        '~'
    } else {
        '`'
    };
    // Only lines that could close the fence matter: a run of `ch`, then whitespace.
    let longest_run = code
        .lines()
        .filter_map(|l| {
            let t = l.trim_start_matches(' ');
            if l.len() - t.len() > 3 {
                return None;
            }
            let run = t.chars().take_while(|&c| c == ch).count();
            t[run..].trim().is_empty().then_some(run)
        })
        .max()
        .unwrap_or(0);
    let len = fence.len().max(3).max(longest_run + 1);
    let fence = ch.to_string().repeat(len);
    // An info string starting with the fence character would lengthen the fence.
    let info = &if info.starts_with(ch) {
        format!(" {info}")
    } else {
        info.clone()
    };
    if code.is_empty() {
        format!("{fence}{info}\n{fence}")
    } else {
        format!("{fence}{info}\n{code}\n{fence}")
    }
}

fn table(node: &Node) -> String {
    // Rows are grouped into `table_head` and `table_body`.
    let all_rows: Vec<&Node> = node
        .content
        .iter()
        .flat_map(|section| &section.content)
        .collect();
    // Column alignment lives on the header cells.
    let align: Vec<Option<String>> = all_rows
        .first()
        .map(|header| {
            let cells = header.content.iter();
            cells
                .map(|cell| cell.attr_str("align").map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let rows: Vec<Vec<String>> = all_rows
        .iter()
        .map(|row| {
            row.content
                .iter()
                .map(|cell| inlines(&cell.content, true))
                .collect()
        })
        .collect();
    let cols = rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .max(align.len());
    if cols == 0 {
        return String::new();
    }
    let mut widths = vec![3usize; cols];
    for row in &rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.width());
        }
    }

    let line = |cells: Vec<String>| -> String {
        let mut s = String::from("|");
        for (i, cell) in cells.into_iter().enumerate() {
            let pad = widths[i].saturating_sub(cell.width());
            s.push(' ');
            s.push_str(&cell);
            s.push_str(&" ".repeat(pad));
            s.push_str(" |");
        }
        s
    };
    let cells_of = |row: &Vec<String>| -> Vec<String> {
        (0..cols)
            .map(|i| row.get(i).cloned().unwrap_or_default())
            .collect()
    };

    let mut out = Vec::with_capacity(rows.len() + 1);
    out.push(line(
        rows.first()
            .map(cells_of)
            .unwrap_or_else(|| vec![String::new(); cols]),
    ));
    let delims = (0..cols)
        .map(|i| {
            let w = widths[i];
            match align.get(i).and_then(|a| a.as_deref()) {
                Some("left") => format!(":{}", "-".repeat(w - 1)),
                Some("center") => format!(":{}:", "-".repeat(w - 2)),
                Some("right") => format!("{}:", "-".repeat(w - 1)),
                _ => "-".repeat(w),
            }
        })
        .collect();
    out.push(line(delims));
    for row in rows.iter().skip(1) {
        out.push(line(cells_of(row)));
    }
    out.join("\n")
}

// ---------------------------------------------------------------------------
// Inline content

fn mark_rank(m: &Mark) -> usize {
    // Autolink text is literal, so other marks have to wrap it from outside.
    if m.kind == "link" && matches!(m.attr_str("kind"), Some("bare") | Some("angle")) {
        return MARK_ORDER.len();
    }
    pm::mark_rank(&m.kind)
}

/// Which delimiter-like characters occur often enough in a block that a literal
/// one could pair up with another and turn into markup.
struct Hazards {
    dollar: bool,
    caret: bool,
    equals: bool,
    close_bracket: bool,
}

impl Hazards {
    fn scan(nodes: &[Node]) -> Self {
        let text: String = nodes.iter().filter_map(|n| n.text.as_deref()).collect();
        let count = |c| text.matches(c).count();
        Hazards {
            dollar: count('$') + nodes.iter().filter(|n| n.kind == "math_inline").count() >= 2
                || count('$') >= 2,
            caret: count('^') >= 2 || nodes.iter().any(|n| has_mark(n, "sup")),
            equals: text.contains("==") || nodes.iter().any(|n| has_mark(n, "highlight")),
            // An unmatched `[` takes part in delimiter processing next to marks.
            close_bracket: text.contains(']')
                || nodes.iter().any(|n| {
                    n.marks
                        .iter()
                        .any(|m| !matches!(m.kind.as_str(), "link" | "code"))
                }),
        }
    }
}

fn has_mark(node: &Node, kind: &str) -> bool {
    node.marks.iter().any(|m| m.kind == kind)
}

struct Inline<'n> {
    nodes: &'n [Node],
    out: String,
    /// Open marks (outermost first) with the delimiter each was opened with.
    open: Vec<(Mark, String)>,
    /// Trailing whitespace of the last text, written after any marks that close.
    pending_ws: String,
    in_table: bool,
    hazards: Hazards,
    /// Output offsets where a line begins with text (not markup).
    text_line_starts: Vec<usize>,
    /// Output length right after the last closing delimiter.
    closed_at: Option<usize>,
}

pub(crate) fn inlines(nodes: &[Node], in_table: bool) -> String {
    let mut w = Inline {
        nodes,
        out: String::new(),
        open: Vec::new(),
        pending_ws: String::new(),
        in_table,
        hazards: Hazards::scan(nodes),
        text_line_starts: Vec::new(),
        closed_at: None,
    };
    for i in 0..nodes.len() {
        w.node(i);
    }
    w.close_to(0);
    w.flush_ws();
    // Escape block-start syntax once whole lines are known: `42` and `)` may come
    // from different nodes.
    let mut out = w.out;
    for &start in w.text_line_starts.iter().rev() {
        let end = out[start..].find('\n').map_or(out.len(), |e| start + e);
        if let Some(at) = line_start_escape(&out[start..end]) {
            out.insert(start + at, '\\');
        }
    }
    out
}

impl Inline<'_> {
    fn node(&mut self, i: usize) {
        let node = &self.nodes[i];
        let mut marks: Vec<&Mark> = node.marks.iter().filter(|m| m.kind != "code").collect();
        marks.sort_by_key(|m| mark_rank(m));

        // Marks stay open as long as they are still active; new ones nest inside.
        let keep = self
            .open
            .iter()
            .position(|(o, _)| !marks.iter().any(|m| same_open(o, m)))
            .unwrap_or(self.open.len());
        self.close_to(keep);

        let text = node.text.as_deref().unwrap_or("");
        let is_code = has_mark(node, "code");
        // Open new marks so that the ones running longest are outermost.
        let mut new: Vec<&Mark> = marks
            .into_iter()
            .filter(|m| !self.open.iter().any(|(o, _)| same_open(o, m)))
            .collect();
        new.sort_by_key(|m| (std::cmp::Reverse(self.run_end(m, i)), mark_rank(m)));
        // Whitespace moves out of delimiter runs (`* a*` is not emphasis), but a link's
        // brackets may hold it, and `[ ](u)` must not become the empty ` [](u)`.
        let hoist = new.iter().any(|m| m.kind != "link");
        let (lead, core) = if is_code || !node.is_text() {
            ("", text)
        } else {
            split_leading_ws(text)
        };
        self.flush_ws();
        if hoist {
            self.out.push_str(lead);
        }
        for m in new {
            self.open_mark(m, i);
        }
        if !hoist {
            self.out.push_str(lead);
        }

        match node.kind.as_str() {
            "text" if is_code => self.code(core),
            "text" => {
                let (core, trail) = split_trailing_ws(core);
                if self.in_bare_link() {
                    self.out.push_str(core);
                } else {
                    let escaped = self.escape(core);
                    self.out.push_str(&escaped);
                }
                // As above: only delimiter runs closing here need the whitespace outside.
                if self.closing_after(i).any(|m| m.kind != "link") {
                    self.pending_ws = trail.to_owned();
                } else {
                    self.out.push_str(trail);
                }
            }
            "soft_break" => self.newline(""),
            "hard_break" => {
                let markup = if node.attr_str("markup") == Some("  ") {
                    "  "
                } else {
                    "\\"
                };
                self.newline(markup);
            }
            "image" => {
                let alt = escape_brackets(node.attr_str("alt").unwrap_or(""));
                let dest = destination(node.attr_str("src").unwrap_or(""), node.attr_str("title"));
                self.out.push_str(&format!("![{alt}]({dest})"));
            }
            "math_inline" => {
                let tex = node.attr_str("tex").unwrap_or("");
                let fence = if node.attr_bool("display") == Some(true) {
                    "$$"
                } else {
                    "$"
                };
                self.out.push_str(&format!("{fence}{tex}{fence}"));
            }
            "html_inline" => self.out.push_str(node.attr_str("html").unwrap_or("")),
            "footnote_ref" => {
                self.out
                    .push_str(&format!("[^{}]", node.attr_str("label").unwrap_or("")));
            }
            _ => self.out.push_str(text),
        }
    }

    fn newline(&mut self, markup: &str) {
        if markup == "\\" {
            self.flush_ws();
        } else {
            // Trailing spaces before a soft break would turn it into a hard break.
            self.pending_ws.clear();
            let trimmed = self.out.trim_end_matches(' ').len();
            self.out.truncate(trimmed);
        }
        self.out.push_str(markup);
        self.out.push('\n');
    }

    fn flush_ws(&mut self) {
        let ws = std::mem::take(&mut self.pending_ws);
        self.out.push_str(&ws);
    }

    fn in_link(&self) -> bool {
        self.open.iter().any(|(m, _)| m.kind == "link")
    }

    fn in_bare_link(&self) -> bool {
        self.open.iter().any(|(m, _)| {
            m.kind == "link" && matches!(m.attr_str("kind"), Some("bare") | Some("angle"))
        })
    }

    fn open_mark(&mut self, mark: &Mark, at: usize) {
        let delim = match mark.kind.as_str() {
            "link" => {
                let kind = self.link_kind(mark, at);
                if self.out.ends_with('!') {
                    self.out.insert(self.out.len() - 1, '\\');
                }
                match kind {
                    "bare" => "",
                    "angle" => "<",
                    _ => "[",
                }
                .to_owned()
            }
            "em" | "strong" => {
                let markup =
                    mark.attr_str("markup")
                        .unwrap_or(if mark.kind == "em" { "*" } else { "**" });
                // `_` cannot open or close emphasis inside a word.
                let intraword = self.out.chars().last().is_some_and(char::is_alphanumeric)
                    || self
                        .char_after_run(mark, at)
                        .is_some_and(char::is_alphanumeric);
                let markup = if markup.starts_with('_') && intraword {
                    markup.replace('_', "*")
                } else {
                    markup.to_owned()
                };
                // A run just closed with the same character would merge with this one
                // (`*a***b**` closes twice); the other character keeps them apart.
                match markup.chars().next() {
                    Some('*') if self.after_closer('*') && !intraword => markup.replace('*', "_"),
                    Some('_') if self.after_closer('_') => markup.replace('_', "*"),
                    _ => markup,
                }
            }
            "strike" => "~~".to_owned(),
            "highlight" => "==".to_owned(),
            "sup" => "^".to_owned(),
            "sub" => "~".to_owned(),
            _ => String::new(),
        };
        // A run that would not parse back as this mark is written without it: the
        // text survives, only the formatting is lost.
        let delim = match delim.chars().next() {
            Some(c) if mark.kind != "link" && !self.delimiters_fit(mark, at, c) => String::new(),
            _ => delim,
        };
        self.out.push_str(&delim);
        let mut mark = mark.clone();
        if mark.kind == "link" {
            let kind = self.link_kind(&mark, at);
            mark.attrs.insert("kind".into(), kind.into());
        }
        self.open.push((mark, delim));
    }

    /// Whether delimiters made of `delim` around the run of `mark` starting at `at`
    /// satisfy CommonMark's left/right-flanking rules.
    fn delimiters_fit(&self, mark: &Mark, at: usize, delim: char) -> bool {
        let rank = mark_rank(mark);
        let end = self.run_end(mark, at);
        let inner = |n: &Node| {
            n.marks
                .iter()
                .any(|m| m.kind != "code" && mark_rank(m) > rank)
        };

        let prev = self.out.chars().last();
        let first_node = &self.nodes[at];
        let first = if inner(first_node) {
            Some('*')
        } else {
            edge_char(first_node, true)
        };
        let last_node = &self.nodes[end - 1];
        let trailing_ws = last_node.is_text()
            && !has_mark(last_node, "code")
            && last_node
                .text
                .as_deref()
                .is_some_and(|t| t.ends_with([' ', '\t']));
        let last = if inner(last_node) && !trailing_ws {
            Some('*')
        } else {
            edge_char(last_node, false)
        };
        let after = if trailing_ws {
            Some(' ')
        } else {
            // Leading whitespace of the next node stays in place, so look at it raw.
            self.nodes.get(end).and_then(|n| match n.text.as_deref() {
                Some(t) if !has_mark(n, "code") => t.chars().next(),
                _ => edge_char(n, true),
            })
        };

        let ws = |c: Option<char>| c.is_none_or(char::is_whitespace);
        let punct = |c: Option<char>| c.is_some_and(|c| !c.is_alphanumeric() && !c.is_whitespace());
        let left = |before: Option<char>, next: Option<char>| {
            !ws(next) && (!punct(next) || ws(before) || punct(before))
        };
        let right = |before: Option<char>, next: Option<char>| {
            !ws(before) && (!punct(before) || ws(next) || punct(next))
        };
        let opens = left(prev, first) && (delim != '_' || !right(prev, first) || punct(prev));
        let closes = right(last, after) && (delim != '_' || !left(last, after) || punct(after));
        // `~`, `^` and `=` runs touching a delimiter of the same character merge into
        // one run (`~a~~~b~~`), unlike nested `*` and `_` runs; but those merge too
        // when one closes right where the next opens.
        let merges = matches!(delim, '~' | '^' | '=')
            && (prev == Some(delim) && !self.out.ends_with(&format!("\\{delim}"))
                || [first_node, last_node].iter().any(|n| {
                    n.marks
                        .iter()
                        .any(|m| mark_rank(m) > rank && delim_char(&m.kind) == Some(delim))
                }))
            || matches!(delim, '*' | '_') && self.after_closer(delim);
        opens && closes && !merges
    }

    /// Bare and angle autolinks only stay autolinks while their text is the URL.
    fn link_kind(&self, mark: &Mark, at: usize) -> &'static str {
        let kind = mark.attr_str("kind").unwrap_or("inline");
        let href = mark.attr_str("href").unwrap_or("");
        match kind {
            "bare" | "angle" => {
                let text = self.run_text(mark, at);
                let text_is_url = text == href
                    || href.strip_prefix("mailto:") == Some(text.as_str())
                    || href.strip_prefix("http://") == Some(text.as_str());
                let next = self.char_after_run(mark, at);
                if !text_is_url {
                    "inline"
                } else if kind == "bare" && next.is_none_or(char::is_whitespace) {
                    "bare"
                } else if href.contains([' ', '<', '>']) {
                    "inline"
                } else {
                    "angle"
                }
            }
            "ref" => "ref",
            _ => "inline",
        }
    }

    /// Index just past the nodes carrying `mark`, starting at node `at`.
    /// The open marks that node `at + 1` does not continue.
    fn closing_after(&self, at: usize) -> impl Iterator<Item = &Mark> {
        let next = self.nodes.get(at + 1);
        self.open
            .iter()
            .map(|(m, _)| m)
            .filter(move |m| !next.is_some_and(|n| n.marks.iter().any(|x| same_open(m, x))))
    }

    fn run_end(&self, mark: &Mark, at: usize) -> usize {
        self.nodes[at..]
            .iter()
            .position(|n| !n.marks.iter().any(|m| same_mark(m, mark)))
            .map_or(self.nodes.len(), |p| at + p)
    }

    /// Plain text of the nodes carrying `mark`, starting at node `at`.
    fn run_text(&self, mark: &Mark, at: usize) -> String {
        self.nodes[at..]
            .iter()
            .take_while(|n| n.marks.iter().any(|m| same_mark(m, mark)))
            .map(|n| n.text.as_deref().unwrap_or(""))
            .collect()
    }

    /// First character after the nodes carrying `mark`; `None` at the end of the block.
    fn char_after_run(&self, mark: &Mark, at: usize) -> Option<char> {
        let end = self.nodes[at..]
            .iter()
            .position(|n| !n.marks.iter().any(|m| same_mark(m, mark)))
            .map(|p| at + p)?;
        match self.nodes[end].kind.as_str() {
            "text" => self.nodes[end].text.as_deref()?.chars().next(),
            "soft_break" | "hard_break" => Some('\n'),
            _ => Some('x'),
        }
    }

    /// Whether the output ends with a closing delimiter run of `delim`.
    fn after_closer(&self, delim: char) -> bool {
        self.closed_at == Some(self.out.len()) && self.out.ends_with(delim)
    }

    fn close_to(&mut self, keep: usize) {
        while self.open.len() > keep {
            let (mark, delim) = self.open.pop().unwrap();
            let closer = match mark.kind.as_str() {
                "link" => match mark.attr_str("kind") {
                    Some("bare") => String::new(),
                    Some("angle") => ">".to_owned(),
                    Some("ref") => format!("]{}", mark.attr_str("ref").unwrap_or("[]")),
                    _ => {
                        let href = mark.attr_str("href").unwrap_or("");
                        format!("]({})", destination(href, mark.attr_str("title")))
                    }
                },
                _ => delim,
            };
            if !closer.is_empty() {
                self.out.push_str(&closer);
                self.closed_at = Some(self.out.len());
            }
        }
        self.flush_ws();
    }

    fn code(&mut self, code: &str) {
        let longest = longest_run(code, '`');
        let ticks = "`".repeat(longest + 1);
        let pad = code.starts_with('`')
            || code.ends_with('`')
            || (code.starts_with(' ') && code.ends_with(' ') && !code.trim().is_empty());
        let pad = if pad { " " } else { "" };
        let code = if self.in_table {
            code.replace('|', "\\|")
        } else {
            code.to_owned()
        };
        self.out
            .push_str(&format!("{ticks}{pad}{code}{pad}{ticks}"));
    }

    fn at_line_start(&self) -> bool {
        self.out.is_empty() || self.out.ends_with('\n')
    }

    fn escape(&mut self, text: &str) -> String {
        if self.at_line_start() && !text.is_empty() {
            self.text_line_starts.push(self.out.len());
        }
        let chars: Vec<char> = text.chars().collect();
        self.escape_chars(&chars, self.out.chars().last())
    }

    fn escape_chars(&self, chars: &[char], before: Option<char>) -> String {
        let mut out = String::with_capacity(chars.len() + 8);
        for (i, &c) in chars.iter().enumerate() {
            let prev = if i == 0 { before } else { Some(chars[i - 1]) };
            let next = chars.get(i + 1).copied();
            let ws = |c: Option<char>| c.is_none_or(char::is_whitespace);
            let alnum = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
            let escape = match c {
                '\\' => next.is_none_or(|n| n.is_ascii_punctuation()),
                '`' => true,
                // A delimiter is literal when surrounded by whitespace. The end of this
                // text node is not known to be whitespace: a mark may open right there.
                '*' => !(prev.is_some() && ws(prev) && next.is_some() && ws(next)),
                '_' => {
                    !(alnum(prev) && alnum(next))
                        && !(prev.is_some() && ws(prev) && next.is_some() && ws(next))
                }
                // `[^` starts a footnote reference; markup may follow the end of the node.
                '[' => self.hazards.close_bracket || next.is_none_or(|n| n == '^'),
                '<' => {
                    next.is_some_and(|n| n.is_ascii_alphabetic() || matches!(n, '/' | '!' | '?'))
                }
                '&' => {
                    let rest: String = chars[i + 1..].iter().take(32).collect();
                    looks_like_entity(&rest)
                }
                '$' => self.hazards.dollar,
                // Any `~` is a delimiter candidate (sub/strike) and can disturb
                // neighbouring emphasis even when unpaired.
                '~' => true,
                '^' => self.hazards.caret,
                '=' => self.hazards.equals && (prev == Some('=') || next == Some('=')),
                '|' => self.in_table,
                // Plain text that looks like a URL must not become an autolink.
                ':' => chars[i + 1..].starts_with(&['/', '/']) && !self.in_link(),
                '.' => i >= 3 && chars[i - 3..i] == ['w', 'w', 'w'] && !self.in_link(),
                '@' => alnum(prev) && alnum(next) && !self.in_link(),
                _ => false,
            };
            if escape {
                out.push('\\');
            }
            out.push(c);
        }
        out
    }
}

/// An open mark (whose link `kind` may have been resolved) matches a node's mark.
fn same_open(open: &Mark, mark: &Mark) -> bool {
    same_mark(open, mark) && open.attr_str("title") == mark.attr_str("title")
}

fn same_mark(a: &Mark, b: &Mark) -> bool {
    a.kind == b.kind && a.attr_str("href") == b.attr_str("href")
}

/// Where to insert a backslash so that a paragraph line does not begin a block.
fn line_start_escape(line: &str) -> Option<usize> {
    let space_after = |i: usize| line[i..].chars().next().is_none_or(char::is_whitespace);
    let only = |set: &[char]| {
        let t = line.trim_end();
        !t.is_empty() && t.chars().all(|c| set.contains(&c) || c == ' ')
    };
    match line.chars().next()? {
        '#' => {
            let hashes = line.chars().take_while(|&c| c == '#').count();
            if hashes <= 6 && space_after(hashes) {
                return Some(0);
            }
        }
        '>' => return Some(0),
        '-' | '+' | '*' if space_after(1) || only(&['-', '*', '_']) => return Some(0),
        '=' if only(&['=']) => return Some(0),
        // Would turn the previous line into a table header.
        '|' | ':' | '-' if only(&['|', ':', '-']) && line.contains('-') => return Some(0),
        '`' | '~' if line.starts_with("```") || line.starts_with("~~~") => return Some(0),
        _ => {}
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    let rest = &line[digits..];
    if (1..=9).contains(&digits)
        && (rest.starts_with('.') || rest.starts_with(')'))
        && space_after(digits + 1)
    {
        return Some(digits);
    }
    None
}

fn looks_like_entity(rest: &str) -> bool {
    let body: String = rest.chars().take_while(|c| *c != ';').collect();
    !body.is_empty()
        && body.len() < rest.len()
        && body.len() <= 31
        && (body.chars().all(|c| c.is_ascii_alphanumeric())
            || (body.starts_with('#') && body[1..].chars().all(|c| c.is_ascii_alphanumeric())))
}

/// The first (or last) character a node writes, ignoring whitespace that moves
/// outside of marks. `None` for an empty node.
fn edge_char(node: &Node, first: bool) -> Option<char> {
    match node.kind.as_str() {
        "text" if has_mark(node, "code") => Some('`'),
        "text" => {
            let t = node.text.as_deref()?.trim_matches([' ', '\t']);
            if first {
                t.chars().next()
            } else {
                t.chars().last()
            }
        }
        "soft_break" | "hard_break" => Some('\n'),
        "image" => Some(if first { '!' } else { ')' }),
        "math_inline" => Some('$'),
        "html_inline" => Some(if first { '<' } else { '>' }),
        "footnote_ref" => Some(if first { '[' } else { ']' }),
        _ => None,
    }
}

fn split_leading_ws(s: &str) -> (&str, &str) {
    let core = s.trim_start_matches([' ', '\t']);
    (&s[..s.len() - core.len()], core)
}

fn split_trailing_ws(s: &str) -> (&str, &str) {
    let core = s.trim_end_matches([' ', '\t']);
    (core, &s[core.len()..])
}

fn longest_run(s: &str, ch: char) -> usize {
    let mut best = 0;
    let mut cur = 0;
    for c in s.chars() {
        if c == ch {
            cur += 1;
            best = best.max(cur);
        } else {
            cur = 0;
        }
    }
    best
}

fn escape_brackets(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn destination(url: &str, title: Option<&str>) -> String {
    let needs_angle = url.is_empty() && title.is_some_and(|t| !t.is_empty())
        || url.contains([' ', '<', '>', '\n'])
        || !balanced_parens(url);
    // Math and code spans bind tighter than links, so `$` and `` ` `` must not pair
    // with delimiters outside the destination.
    let url = url
        .replace('\\', "\\\\")
        .replace('$', "\\$")
        .replace('`', "\\`");
    let mut dest = if needs_angle {
        format!("<{}>", url.replace('<', "\\<").replace('>', "\\>"))
    } else {
        url
    };
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        let title = title.replace('\\', "\\\\").replace('"', "\\\"");
        dest.push_str(&format!(" \"{title}\""));
    }
    dest
}

fn balanced_parens(s: &str) -> bool {
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// The character delimiting a non-emphasis mark.
fn delim_char(kind: &str) -> Option<char> {
    match kind {
        "strike" | "sub" => Some('~'),
        "sup" => Some('^'),
        "highlight" => Some('='),
        _ => None,
    }
}
