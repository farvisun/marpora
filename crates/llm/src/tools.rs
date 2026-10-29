//! Tools over the user's folder, for a chat about all of its files: the API providers
//! call them in a tool loop (anthropic.rs, openai.rs), and the CLIs run in the folder
//! with their own read-only tools instead (cli.rs).

use std::path::Path;

use serde_json::{Value, json};

/// The folder and what the tools do in it; the app implements them.
pub trait FolderTools: Send + Sync {
    /// The folder, where a CLI provider runs.
    fn root(&self) -> &Path;
    /// Run tool `name` (one of `folder_tools`) with `input`, as the model gave it: the
    /// text for the model, or an error to tell it.
    fn call(&self, name: &str, input: &Value) -> Result<String, String>;
}

/// A tool as the model sees it.
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema of the input.
    pub schema: Value,
}

pub fn folder_tools() -> Vec<ToolSpec> {
    let path = json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "The file's path relative to the folder, as search_files and list_files give it." }
        },
        "required": ["path"],
    });
    vec![
        ToolSpec {
            name: "search_files",
            description: "Search the Markdown files in the user's folder for text (plain text, \
                not case-sensitive). Returns the matching lines with each file's path and the \
                lines' numbers.",
            schema: json!({
                "type": "object",
                "properties": { "query": { "type": "string", "description": "The text to find." } },
                "required": ["query"],
            }),
        },
        ToolSpec {
            name: "list_files",
            description: "List the Markdown files in the user's folder, by path relative to it, \
                newest first.",
            schema: json!({ "type": "object", "properties": {} }),
        },
        ToolSpec {
            name: "read_file",
            description: "Read one Markdown file in the user's folder.",
            schema: path.clone(),
        },
        ToolSpec {
            name: "get_outline",
            description: "List one Markdown file's headings, with their levels and line numbers.",
            schema: path,
        },
    ]
}

/// The string `key` of a tool's `input`, or the error to give the model.
pub fn string_arg<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{key} is required and must be a string"))
}

/// What the model sees of the folder in the system prompt.
pub(crate) const FOLDER_NOTE: &str = "The user's folder of Markdown files is open in the \
editor. To answer from its other files, search and read them with your tools, and name \
the files you used.";
