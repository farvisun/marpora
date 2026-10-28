//! ProseMirror-compatible JSON document model.
//!
//! The shape matches `Node.toJSON()` / `Node.fromJSON()` in prosemirror-model, so the
//! same values cross the WASM boundary and the Tauri IPC boundary unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub attrs: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content: Vec<Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<Mark>,
}

/// Mark types in schema order. ProseMirror keeps a node's marks sorted by this rank,
/// so the order must match `web/editor/schema.ts`.
pub const MARK_ORDER: [&str; 8] = [
    "link",
    "em",
    "strong",
    "strike",
    "highlight",
    "sup",
    "sub",
    "code",
];

pub fn mark_rank(kind: &str) -> usize {
    MARK_ORDER
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(MARK_ORDER.len())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mark {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub attrs: Map<String, Value>,
}

impl Node {
    pub fn new(kind: &str) -> Self {
        Node {
            kind: kind.to_owned(),
            attrs: Map::new(),
            content: Vec::new(),
            text: None,
            marks: Vec::new(),
        }
    }

    pub fn text(text: impl Into<String>, marks: Vec<Mark>) -> Self {
        Node {
            text: Some(text.into()),
            marks,
            ..Node::new("text")
        }
    }

    pub fn attr(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.attrs.insert(key.to_owned(), value.into());
        self
    }

    pub fn children(mut self, content: Vec<Node>) -> Self {
        self.content = content;
        self
    }

    pub fn is_text(&self) -> bool {
        self.kind == "text"
    }

    pub fn attr_str(&self, key: &str) -> Option<&str> {
        self.attrs.get(key).and_then(Value::as_str)
    }

    pub fn attr_bool(&self, key: &str) -> Option<bool> {
        self.attrs.get(key).and_then(Value::as_bool)
    }

    pub fn attr_u64(&self, key: &str) -> Option<u64> {
        self.attrs.get(key).and_then(Value::as_u64)
    }

    /// Concatenated text of all descendants, ignoring markup.
    pub fn text_content(&self) -> String {
        let mut out = String::new();
        self.collect_text(&mut out);
        out
    }

    fn collect_text(&self, out: &mut String) {
        if let Some(t) = &self.text {
            out.push_str(t);
        }
        for c in &self.content {
            c.collect_text(out);
        }
    }
}

impl Mark {
    pub fn new(kind: &str) -> Self {
        Mark {
            kind: kind.to_owned(),
            attrs: Map::new(),
        }
    }

    pub fn attr(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.attrs.insert(key.to_owned(), value.into());
        self
    }

    pub fn attr_str(&self, key: &str) -> Option<&str> {
        self.attrs.get(key).and_then(Value::as_str)
    }
}
