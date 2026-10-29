//! `marpora mcp`: an MCP server on stdin and stdout (JSON-RPC, one message a line)
//! whose tools act on the documents open in Marpora, through the agent socket
//! (agent.rs). Add it to Claude Code with `claude mcp add marpora -- <app>/marpora mcp`.

use std::io::{BufRead, BufReader, Write};

use serde_json::{Value, json};

const PROTOCOL: &str = "2025-06-18";

const INSTRUCTIONS: &str = "Tools for the Markdown documents open in the Marpora editor. \
Edits show in the editor at once, and the user can undo them. Documents are named by id \
(from list_documents) or path; with none, tools act on the document in front. Read a \
document before editing it, and edit with exact text from it.";

/// The tools, as `tools/list` describes them.
fn tools() -> Value {
    let document = json!({
        "type": ["integer", "string"],
        "description": "The document's id (from list_documents) or path. Defaults to the one in front."
    });
    let only_document = json!({ "type": "object", "properties": { "document": document } });
    json!([
        {
            "name": "list_documents",
            "description": "List the documents open in Marpora: id, path, title, whether they have unsaved changes, and which is in front.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_document",
            "description": "Read a document's Markdown as it is in the editor, unsaved changes included.",
            "inputSchema": only_document,
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "get_outline",
            "description": "List a document's headings with their levels.",
            "inputSchema": only_document,
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "get_selection",
            "description": "What the user has selected in a document: the selected text as shown, and the Markdown of the blocks it touches (which edit_document can quote).",
            "inputSchema": only_document,
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "edit_document",
            "description": "Replace exact text in a document's Markdown. old_text must occur once, unless replace_all is set. The change shows in the editor at once and is not saved to disk.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "document": document,
                    "old_text": { "type": "string", "description": "Text to replace, exactly as in the Markdown." },
                    "new_text": { "type": "string", "description": "The replacement." },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence." }
                },
                "required": ["old_text", "new_text"]
            }
        },
        {
            "name": "write_document",
            "description": "Replace a document's whole Markdown. Prefer edit_document for changes to part of it.",
            "inputSchema": {
                "type": "object",
                "properties": { "document": document, "text": { "type": "string" } },
                "required": ["text"]
            }
        },
        {
            "name": "open_file",
            "description": "Open a Markdown file in a Marpora window and return its document id.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Absolute path." } },
                "required": ["path"]
            }
        },
        {
            "name": "create_document",
            "description": "Create a document with some Markdown: a new file at path (which must not exist), or an untitled window when path is left out.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path for a new file." },
                    "text": { "type": "string" }
                }
            }
        },
        {
            "name": "save_document",
            "description": "Save a document that has a file to disk.",
            "inputSchema": only_document
        }
    ])
}

/// Serve MCP on stdin and stdout until stdin closes.
pub fn run() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let replies: Vec<Value> = batch.iter().filter_map(handle).collect();
                (!replies.is_empty()).then(|| json!(replies))
            }
            Ok(message) => handle(&message),
            Err(e) => Some(error(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        if let Some(reply) = reply {
            if writeln!(stdout, "{reply}").is_err() {
                break;
            }
            let _ = stdout.flush();
        }
    }
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The reply to one message; none for notifications.
fn handle(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => json!({
            "protocolVersion": params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "marpora", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let (text, failed) = match call(name, args) {
                Ok(Value::String(s)) => (s, false),
                Ok(v) => (serde_json::to_string_pretty(&v).unwrap_or_default(), false),
                Err(e) => (e, true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        _ => return Some(error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Ask the running editor to run tool `name`.
#[cfg(unix)]
fn call(name: &str, args: Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;
    if !tools()
        .as_array()
        .is_some_and(|t| t.iter().any(|t| t["name"] == name))
    {
        return Err(format!("unknown tool {name}"));
    }
    let path = crate::agent::socket_path().ok_or("no home folder")?;
    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(_) => launch_app()
            .then(|| {
                // The app opens the socket as it starts.
                (0..40).find_map(|_| {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    UnixStream::connect(&path).ok()
                })
            })
            .flatten()
            .ok_or("Marpora is not running; ask the user to open it.")?,
    };
    writeln!(stream, "{}", json!({ "method": name, "params": args })).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&stream)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_str(&line).map_err(|e| format!("bad reply: {e}"))?;
    match reply.get("error").and_then(Value::as_str) {
        Some(e) => Err(e.to_owned()),
        None => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
    }
}

/// Start the app this binary belongs to, when it is inside an app bundle.
#[cfg(unix)]
fn launch_app() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    // <Marpora.app>/Contents/MacOS/marpora
    let Some(bundle) = exe
        .ancestors()
        .nth(3)
        .filter(|b| b.extension().is_some_and(|e| e == "app"))
    else {
        return false;
    };
    std::process::Command::new("open")
        .args(["-g", "-a"])
        .arg(bundle)
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(unix))]
fn call(_name: &str, _args: Value) -> Result<Value, String> {
    Err("not available on this platform yet".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_handshake_and_lists_tools() {
        let init = handle(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26" }
        }))
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "marpora");
        assert!(
            handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none()
        );
        let list = handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"edit_document") && names.contains(&"read_document"));
        let missing = handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" })).unwrap();
        assert_eq!(missing["error"]["code"], -32601);
    }
}
