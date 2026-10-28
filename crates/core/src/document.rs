//! A Markdown document as a list of top-level blocks with the exact bytes between them.
//!
//! The editor reports edits as [`Patch`]es that replace a range of blocks with newly
//! serialized Markdown. Blocks it did not touch keep their original bytes, and so do the
//! separators around them, so saving rewrites only what the user changed.

use serde::{Deserialize, Serialize};

use marpora_md::Flavor;
use marpora_md::pm::Node;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    /// Source of the block, without trailing blank lines.
    pub text: String,
    /// Whitespace after the block, up to the next block (or end of file).
    pub sep: String,
}

/// An edit from the editor: replace `delete` blocks starting at `start` with `insert`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub base_version: u64,
    pub start: usize,
    pub delete: usize,
    pub insert: Vec<String>,
}

/// An edit made outside the editor (agent, AI, file on disk), for the editor to apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePatch {
    pub version: u64,
    pub start: usize,
    pub delete: usize,
    /// ProseMirror JSON for the inserted blocks.
    pub insert: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PatchError {
    #[error("patch is based on version {base} but the document is at {current}")]
    Stale { base: u64, current: u64 },
    #[error("block range {start}+{delete} is outside the document ({len} blocks)")]
    OutOfRange {
        start: usize,
        delete: usize,
        len: usize,
    },
}

#[derive(Debug, Clone)]
pub struct Document {
    lead: String,
    blocks: Vec<Block>,
    crlf: bool,
    version: u64,
    saved_version: u64,
}

impl Document {
    pub fn from_markdown(src: &str) -> Self {
        let (lead, blocks) = split(src);
        Document {
            lead,
            blocks,
            crlf: src.contains("\r\n"),
            version: 0,
            saved_version: 0,
        }
    }

    pub fn text(&self) -> String {
        let len = self.lead.len()
            + self
                .blocks
                .iter()
                .map(|b| b.text.len() + b.sep.len())
                .sum::<usize>();
        let mut out = String::with_capacity(len);
        out.push_str(&self.lead);
        for b in &self.blocks {
            out.push_str(&b.text);
            out.push_str(&b.sep);
        }
        out
    }

    pub fn blocks(&self) -> &[Block] {
        &self.blocks
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn is_dirty(&self) -> bool {
        self.version != self.saved_version
    }

    pub fn mark_saved(&mut self, version: u64) {
        self.saved_version = version;
    }

    /// Apply an edit from the editor. Returns the new version.
    pub fn apply(&mut self, patch: &Patch) -> Result<u64, PatchError> {
        if patch.base_version != self.version {
            return Err(PatchError::Stale {
                base: patch.base_version,
                current: self.version,
            });
        }
        let end = patch.start + patch.delete;
        if end > self.blocks.len() {
            return Err(PatchError::OutOfRange {
                start: patch.start,
                delete: patch.delete,
                len: self.blocks.len(),
            });
        }

        let old_len = self.blocks.len();
        let block_sep = self.line_endings(marpora_md::BLOCK_SEP);
        let at_end = end == old_len;
        // Whatever followed the replaced range (a separator or the file tail) carries over
        // to whatever now ends the range.
        let carried = match (patch.delete, at_end) {
            (0, false) => None,
            (0, true) if old_len > 0 => Some(std::mem::replace(
                &mut self.blocks[old_len - 1].sep,
                block_sep.clone(),
            )),
            (0, true) => None,
            (_, _) => Some(self.blocks[end - 1].sep.clone()),
        };
        let inserted: Vec<Block> = patch
            .insert
            .iter()
            .map(|md| Block {
                text: self.line_endings(md),
                sep: block_sep.clone(),
            })
            .collect();
        let count = inserted.len();
        self.blocks.splice(patch.start..end, inserted);

        let range_end = patch.start + count;
        if let Some(sep) = carried
            && range_end > 0
        {
            self.blocks[range_end - 1].sep = sep;
        }
        if !self.blocks.is_empty() {
            self.keep_apart(
                patch.start.saturating_sub(1),
                range_end.min(self.blocks.len() - 1),
            );
        } else {
            self.lead.clear();
        }
        self.version += 1;
        Ok(self.version)
    }

    /// Replace the whole text (an external change) and describe it as the smallest
    /// block-range edit, for the editor to apply. `flavor` is the editor's, since the
    /// patch carries parsed blocks.
    pub fn replace_text(&mut self, src: &str, flavor: &Flavor) -> Option<RemotePatch> {
        let parsed = marpora_md::parse(src, flavor);
        let (lead, blocks) = split_parsed(src, &parsed);
        let old: Vec<&str> = self.blocks.iter().map(|b| b.text.as_str()).collect();
        let new: Vec<&str> = blocks.iter().map(|b| b.text.as_str()).collect();
        if old == new && self.lead == lead && self.blocks == blocks {
            return None;
        }
        let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
        let max_suffix = old.len().min(new.len()) - prefix;
        let suffix = old
            .iter()
            .rev()
            .zip(new.iter().rev())
            .take(max_suffix)
            .take_while(|(a, b)| a == b)
            .count();

        let insert = parsed.doc.content[prefix..new.len() - suffix].to_vec();
        let patch = RemotePatch {
            version: self.version + 1,
            start: prefix,
            delete: old.len() - prefix - suffix,
            insert,
        };
        self.lead = lead;
        self.blocks = blocks;
        self.crlf = src.contains("\r\n");
        self.version += 1;
        Some(patch)
    }

    fn line_endings(&self, s: &str) -> String {
        if self.crlf {
            s.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            s.to_owned()
        }
    }

    /// Make sure adjacent blocks in `first..=last` cannot merge when the separator
    /// between them has no blank line (e.g. `# H\ntext` in the original).
    fn keep_apart(&mut self, first: usize, last: usize) {
        let blank = self.line_endings("\n\n");
        for i in first..last {
            let (a, b) = (&self.blocks[i], &self.blocks[i + 1]);
            let has_blank = a.sep.matches('\n').count() >= 2;
            if !has_blank && !(self_contained(&a.text) || self_contained(&b.text)) {
                self.blocks[i].sep = blank.clone();
            }
        }
    }
}

/// Blocks that neither absorb the next line nor get absorbed by the previous one
/// (they interrupt paragraphs), so a single newline next to them is safe.
/// `$$` math is not one of them: comrak parses it inside a paragraph.
fn self_contained(md: &str) -> bool {
    let t = md.trim_start();
    (t.starts_with('#') && !t.contains('\n')) || t.starts_with("```") || t.starts_with("~~~")
}

/// Block spans do not depend on the flavor: it only changes inline syntax.
fn split(src: &str) -> (String, Vec<Block>) {
    split_parsed(src, &marpora_md::parse(src, &Flavor::default()))
}

fn split_parsed(src: &str, parsed: &marpora_md::Parsed) -> (String, Vec<Block>) {
    let spans = &parsed.blocks;
    let lead = spans.first().map_or(src, |s| &src[..s.start]).to_owned();
    let blocks = spans
        .iter()
        .enumerate()
        .map(|(i, span)| {
            let next = spans.get(i + 1).map_or(src.len(), |s| s.start);
            Block {
                text: src[span.clone()].to_owned(),
                sep: src[span.end..next].to_owned(),
            }
        })
        .collect();
    (lead, blocks)
}
