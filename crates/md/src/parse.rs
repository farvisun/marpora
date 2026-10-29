//! Markdown → ProseMirror JSON, plus the byte span of every top-level block.
//!
//! Every top-level PM node corresponds to exactly one span of the source, and the
//! text between spans is whitespace only. Source that comrak consumes without
//! producing a node (link reference definitions) or that the editor has no node
//! type for becomes a `raw_block`, so no byte of the document is ever invisible.

use std::ops::Range;

use comrak::nodes::{AstNode, ListDelimType, ListType, NodeValue, Sourcepos, TableAlignment};
use comrak::{Arena, parse_document};

use crate::options::{Flavor, options};
use crate::pm::{Mark, Node, mark_rank};

#[derive(Debug, Clone)]
pub struct Parsed {
    /// The `doc` node. `doc.content[i]` was parsed from `src[blocks[i]]`.
    pub doc: Node,
    pub blocks: Vec<Range<usize>>,
}

pub fn parse(src: &str, flavor: &Flavor) -> Parsed {
    let arena = Arena::new();
    let root = parse_document(&arena, src, &options(flavor));
    let cx = Cx {
        src,
        lines: LineIndex::new(src),
        flavor: *flavor,
    };

    let mut content = Vec::new();
    let mut blocks = Vec::new();
    let mut cursor = 0;

    for child in root.children() {
        let Some(span) = cx.block_span(child.data().sourcepos, cursor) else {
            continue;
        };
        cx.push_raw_gap(cursor..span.start, &mut content, &mut blocks);
        content.push(cx.block(child, span.clone()));
        cursor = span.end;
        blocks.push(span);
    }
    cx.push_raw_gap(cursor..src.len(), &mut content, &mut blocks);

    if content.is_empty() {
        let at = src.len().min(leading_ws_len(src));
        content.push(Node::new("paragraph"));
        blocks.push(at..at);
    }

    Parsed {
        doc: Node::new("doc").children(content),
        blocks,
    }
}

fn leading_ws_len(s: &str) -> usize {
    s.len() - s.trim_start().len()
}

struct LineIndex {
    starts: Vec<usize>,
    len: usize,
}

impl LineIndex {
    fn new(src: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(src.match_indices('\n').map(|(i, _)| i + 1));
        LineIndex {
            starts,
            len: src.len(),
        }
    }

    /// Byte offset of the start of a 1-based line.
    fn line_start(&self, line: usize) -> usize {
        self.starts
            .get(line.saturating_sub(1))
            .copied()
            .unwrap_or(self.len)
    }

    /// Byte offset of the end of a 1-based line, excluding the newline.
    fn line_end(&self, line: usize) -> usize {
        match self.starts.get(line) {
            Some(next) => next - 1,
            None => self.len,
        }
    }

    fn offset(&self, line: usize, column: usize) -> usize {
        (self.line_start(line) + column.saturating_sub(1)).min(self.len)
    }
}

struct Cx<'s> {
    src: &'s str,
    lines: LineIndex,
    flavor: Flavor,
}

impl<'s> Cx<'s> {
    /// Whole lines covered by a top-level node, without trailing blank lines.
    fn block_span(&self, sp: Sourcepos, cursor: usize) -> Option<Range<usize>> {
        if sp.start.line == 0 {
            return None;
        }
        let start = self.lines.line_start(sp.start.line).max(cursor);
        let limit = self.lines.line_end(sp.end.line).max(start);
        let text = &self.src[start..limit];
        // Drop trailing blank lines but keep trailing spaces of the last content line.
        let content_end = start + text.trim_end().len();
        let end = match self.src[content_end..limit].find('\n') {
            Some(nl) => content_end + nl,
            None => limit,
        };
        Some(start..trim_cr(self.src, end).max(start))
    }

    fn push_raw_gap(
        &self,
        gap: Range<usize>,
        content: &mut Vec<Node>,
        blocks: &mut Vec<Range<usize>>,
    ) {
        let text = &self.src[gap.clone()];
        if text.trim().is_empty() {
            return;
        }
        let start = gap.start + leading_ws_len(text);
        // Back up to the start of the line so indentation is preserved.
        let start = self.src[..start]
            .rfind('\n')
            .map_or(0, |i| i + 1)
            .max(gap.start);
        let end = gap.start + text.trim_end().len();
        content.push(raw_block(&self.src[start..end]));
        blocks.push(start..end);
    }

    fn slice(&self, sp: Sourcepos) -> &'s str {
        let start = self.lines.offset(sp.start.line, sp.start.column);
        let end = (self.lines.offset(sp.end.line, sp.end.column) + 1).min(self.src.len());
        self.src.get(start..end.max(start)).unwrap_or("")
    }

    fn byte_at(&self, sp: Sourcepos) -> Option<u8> {
        let at = self.lines.offset(sp.start.line, sp.start.column);
        self.src.as_bytes().get(at).copied()
    }

    fn block<'a>(&self, node: &'a AstNode<'a>, span: Range<usize>) -> Node {
        let data = node.data();
        match &data.value {
            NodeValue::Paragraph => {
                if self
                    .slice(data.sourcepos)
                    .trim()
                    .eq_ignore_ascii_case("[toc]")
                {
                    return Node::new("toc");
                }
                if let Some(tex) = sole_display_math(node) {
                    return Node::new("math_block").children(text_children(&tex));
                }
                Node::new("paragraph").children(self.inline_children(node))
            }
            NodeValue::Heading(h) => Node::new("heading")
                .attr("level", h.level)
                .attr("setext", h.setext)
                .children(self.inline_children(node)),
            NodeValue::BlockQuote => {
                Node::new("blockquote").children(non_empty(self.block_children(node)))
            }
            NodeValue::List(list) => {
                let kind = match list.list_type {
                    ListType::Bullet => Node::new("bullet_list")
                        .attr("bullet", (list.bullet_char as char).to_string()),
                    ListType::Ordered => Node::new("ordered_list").attr("start", list.start).attr(
                        "delim",
                        match list.delimiter {
                            ListDelimType::Period => ".",
                            ListDelimType::Paren => ")",
                        },
                    ),
                };
                kind.attr("tight", list.tight)
                    .children(self.block_children(node))
            }
            NodeValue::Item(_) => Node::new("list_item")
                .attr("checked", serde_json::Value::Null)
                .children(non_empty(self.block_children(node))),
            NodeValue::TaskItem(task) => Node::new("list_item")
                .attr("checked", task.symbol.is_some_and(|c| c != ' '))
                .children(non_empty(self.block_children(node))),
            NodeValue::CodeBlock(code) => {
                let fence = if code.fenced {
                    (code.fence_char as char)
                        .to_string()
                        .repeat(code.fence_length)
                } else {
                    String::new()
                };
                let literal = code.literal.strip_suffix('\n').unwrap_or(&code.literal);
                Node::new("code_block")
                    .attr("info", code.info.clone())
                    .attr("fence", fence)
                    .children(text_children(literal))
            }
            NodeValue::HtmlBlock(html) => {
                let literal = html.literal.trim_end_matches('\n');
                Node::new("html_block").children(text_children(literal))
            }
            NodeValue::ThematicBreak => {
                // Nested spans start at the line, so take the markup from sourcepos.
                Node::new("horizontal_rule")
                    .attr("markup", self.slice(data.sourcepos).trim().to_owned())
            }
            NodeValue::Table(table) => {
                let align: Vec<serde_json::Value> = table
                    .alignments
                    .iter()
                    .map(|a| match a {
                        TableAlignment::None => serde_json::Value::Null,
                        TableAlignment::Left => "left".into(),
                        TableAlignment::Center => "center".into(),
                        TableAlignment::Right => "right".into(),
                    })
                    .collect();
                // Typora renders <thead>/<tbody>, which themes rely on for striping.
                let mut rows = node.children().map(|row| self.table_row(row, &align));
                let head = Node::new("table_head").children(rows.next().into_iter().collect());
                let body = Node::new("table_body").children(rows.collect());
                Node::new("table").children(vec![head, body])
            }
            NodeValue::FrontMatter(raw) => {
                Node::new("front_matter").children(text_children(&front_matter_body(raw)))
            }
            NodeValue::FootnoteDefinition(def) => Node::new("footnote_def")
                .attr("label", def.name.clone())
                .children(non_empty(self.block_children(node))),
            _ => raw_block(&self.src[span]),
        }
    }

    fn block_children<'a>(&self, node: &'a AstNode<'a>) -> Vec<Node> {
        node.children()
            .map(|child| {
                let sp = child.data().sourcepos;
                let span = self.lines.line_start(sp.start.line)..self.lines.line_end(sp.end.line);
                let span = span.start..span.end.max(span.start);
                self.block(child, span)
            })
            .collect()
    }

    fn table_row<'a>(&self, row: &'a AstNode<'a>, align: &[serde_json::Value]) -> Node {
        let header = matches!(row.data().value, NodeValue::TableRow(true));
        let cell_kind = if header { "table_header" } else { "table_cell" };
        let cells = row
            .children()
            .enumerate()
            .map(|(i, cell)| {
                Node::new(cell_kind)
                    .attr("align", align.get(i).cloned().unwrap_or_default())
                    .children(self.inline_children(cell))
            })
            .collect();
        Node::new("table_row").children(cells)
    }

    fn inline_children<'a>(&self, node: &'a AstNode<'a>) -> Vec<Node> {
        let mut out = Vec::new();
        let mut marks = Vec::new();
        for child in node.children() {
            self.inline(child, &mut marks, &mut out);
        }
        out
    }

    fn inline<'a>(&self, node: &'a AstNode<'a>, marks: &mut Vec<Mark>, out: &mut Vec<Node>) {
        let data = node.data();
        let sp = data.sourcepos;
        let mark = match &data.value {
            NodeValue::Text(t) => return push_text(out, t, marks),
            NodeValue::Raw(t) => return push_text(out, t, marks),
            NodeValue::SoftBreak => return out.push(with_marks(Node::new("soft_break"), marks)),
            NodeValue::LineBreak => {
                let markup = if self.byte_at(sp) == Some(b'\\') {
                    "\\"
                } else {
                    "  "
                };
                return out.push(with_marks(
                    Node::new("hard_break").attr("markup", markup),
                    marks,
                ));
            }
            NodeValue::Code(code) => {
                let mut m = marks.clone();
                m.push(Mark::new("code"));
                return push_text(out, &code.literal, &m);
            }
            NodeValue::HtmlInline(html) => {
                return out.push(with_marks(
                    Node::new("html_inline").attr("html", html.clone()),
                    marks,
                ));
            }
            // `$$` blocks are handled in `block`; with inline math off, the rest is text.
            NodeValue::Math(_) if !self.flavor.inline_math => {
                return push_source_text(out, self.slice(sp), marks);
            }
            NodeValue::Math(math) => {
                return out.push(with_marks(
                    Node::new("math_inline")
                        .attr("tex", math.literal.clone())
                        .attr("display", math.display_math),
                    marks,
                ));
            }
            NodeValue::FootnoteReference(r) => {
                return out.push(with_marks(
                    Node::new("footnote_ref").attr("label", r.name.clone()),
                    marks,
                ));
            }
            NodeValue::Image(link) => {
                let alt = node
                    .descendants()
                    .skip(1)
                    .filter_map(|n| match &n.data().value {
                        NodeValue::Text(t) => Some(t.to_string()),
                        NodeValue::Code(c) => Some(c.literal.clone()),
                        _ => None,
                    });
                return out.push(with_marks(
                    Node::new("image")
                        .attr("src", link.url.clone())
                        .attr("alt", alt.collect::<String>())
                        .attr("title", link.title.clone()),
                    marks,
                ));
            }
            NodeValue::Emph => {
                let markup = if self.byte_at(sp) == Some(b'_') {
                    "_"
                } else {
                    "*"
                };
                Some(Mark::new("em").attr("markup", markup))
            }
            NodeValue::Strong => {
                let markup = if self.byte_at(sp) == Some(b'_') {
                    "__"
                } else {
                    "**"
                };
                Some(Mark::new("strong").attr("markup", markup))
            }
            // GFM also accepts `~a~`; Typora only `~~a~~`.
            NodeValue::Strikethrough if !self.slice(sp).starts_with("~~") => {
                push_text(out, "~", marks);
                for child in node.children() {
                    self.inline(child, marks, out);
                }
                return push_text(out, "~", marks);
            }
            NodeValue::Strikethrough => Some(Mark::new("strike")),
            NodeValue::Highlight => Some(Mark::new("highlight")),
            NodeValue::Superscript => Some(Mark::new("sup")),
            NodeValue::Subscript => Some(Mark::new("sub")),
            NodeValue::Link(link) => {
                let kind = match self.byte_at(sp) {
                    Some(b'[') => "inline",
                    Some(b'<') => "angle",
                    _ => "bare",
                };
                // Reference-style links keep their source so they survive re-serialization.
                let kind = if kind == "inline" && !self.slice(sp).ends_with(')') {
                    "ref"
                } else {
                    kind
                };
                let mut m = Mark::new("link")
                    .attr("href", link.url.clone())
                    .attr("title", link.title.clone())
                    .attr("kind", kind);
                if kind == "ref" {
                    let source = self.slice(sp);
                    let label_start = source.rfind('[').unwrap_or(0);
                    m = m.attr("ref", source[label_start..].to_owned());
                }
                Some(m)
            }
            _ => None,
        };
        if let Some(mark) = &mark {
            marks.push(mark.clone());
        }
        for child in node.children() {
            self.inline(child, marks, out);
        }
        if mark.is_some() {
            marks.pop();
        }
    }
}

fn trim_cr(src: &str, end: usize) -> usize {
    if end > 0 && src.as_bytes()[end - 1] == b'\r' {
        end - 1
    } else {
        end
    }
}

fn sorted(marks: &[Mark]) -> Vec<Mark> {
    let mut marks = marks.to_vec();
    // Stable sort keeps the outermost of nested same-type marks first; PM allows one per type.
    marks.sort_by_key(|m| mark_rank(&m.kind));
    marks.dedup_by(|b, a| a.kind == b.kind);
    marks
}

fn with_marks(mut node: Node, marks: &[Mark]) -> Node {
    node.marks = sorted(marks);
    node
}

/// Inline source shown as text, with its line breaks as soft breaks, as comrak
/// would have parsed it without the extension.
fn push_source_text(out: &mut Vec<Node>, source: &str, marks: &[Mark]) {
    for (i, line) in source.split('\n').enumerate() {
        let line = line.trim_end_matches(['\r', ' ', '\t']);
        if i > 0 {
            out.push(with_marks(Node::new("soft_break"), marks));
        }
        let line = if i > 0 {
            line.trim_start_matches([' ', '\t'])
        } else {
            line
        };
        push_text(out, line, marks);
    }
}

fn push_text(out: &mut Vec<Node>, text: &str, marks: &[Mark]) {
    if text.is_empty() {
        return;
    }
    let marks = sorted(marks);
    if let Some(last) = out.last_mut()
        && last.is_text()
        && last.marks == marks
    {
        last.text.get_or_insert_default().push_str(text);
        return;
    }
    out.push(Node::text(text, marks));
}

fn text_children(text: &str) -> Vec<Node> {
    if text.is_empty() {
        Vec::new()
    } else {
        vec![Node::text(text, Vec::new())]
    }
}

fn non_empty(content: Vec<Node>) -> Vec<Node> {
    if content.is_empty() {
        vec![Node::new("paragraph")]
    } else {
        content
    }
}

fn raw_block(source: &str) -> Node {
    Node::new("raw_block").children(text_children(source))
}

fn sole_display_math<'a>(paragraph: &'a AstNode<'a>) -> Option<String> {
    let mut children = paragraph.children();
    let first = children.next()?;
    if children.next().is_some() {
        return None;
    }
    match &first.data().value {
        NodeValue::Math(m) if m.display_math => Some(m.literal.trim_matches('\n').to_owned()),
        _ => None,
    }
}

/// The YAML between the `---` delimiters.
fn front_matter_body(raw: &str) -> String {
    let raw = raw.trim_end();
    let body = raw.strip_prefix("---").unwrap_or(raw);
    let body = body.strip_suffix("---").unwrap_or(body);
    body.trim_start_matches(['\r', '\n'])
        .trim_end_matches(['\r', '\n'])
        .to_owned()
}
