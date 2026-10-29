//! The agent socket: coding agents (Claude Code, Codex, any MCP client) reach the open
//! documents through `marpora mcp` (mcp.rs), which relays each tool call here as one
//! JSON line, `{"method": …, "params": {…}}`, and reads back `{"result": …}` or
//! `{"error": "…"}`. Edits go through the document like changes on disk do, so the
//! editor shows them at once and Undo takes them back. With Preferences › AI › Agents
//! set to ask first, an edit is shown to the user as a suggestion instead, and the call
//! waits for them to accept or reject it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::docs::Docs;
use crate::save::Autosave;
use crate::settings::Store;

/// The socket's path: in the app's data folder, or `MARPORA_SOCKET`.
pub fn socket_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("MARPORA_SOCKET") {
        return Some(PathBuf::from(p));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    #[cfg(target_os = "macos")]
    let data = home.join("Library/Application Support");
    #[cfg(not(target_os = "macos"))]
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    Some(data.join("app.marpora.editor/marpora.sock"))
}

/// The document window last in front, which tools act on when they name none.
static FOCUSED: Mutex<Option<String>> = Mutex::new(None);

/// The selection each document's editor last reported.
static SELECTIONS: Mutex<Option<HashMap<u64, Selection>>> = Mutex::new(None);

/// A selection in the editor: its text as shown, and the top level blocks it spans.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub text: String,
    pub start_block: usize,
    pub end_block: usize,
}

pub fn focused(label: &str) {
    if label.starts_with("doc-") {
        *FOCUSED.lock().unwrap() = Some(label.to_owned());
    }
}

pub fn set_selection(id: u64, selection: Option<Selection>) {
    let mut map = SELECTIONS.lock().unwrap();
    let map = map.get_or_insert_with(HashMap::new);
    match selection {
        Some(s) => map.insert(id, s),
        None => map.remove(&id),
    };
}

/// Listen on the socket, on a thread of its own; each connection gets one too.
#[cfg(unix)]
pub fn serve(app: &AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    let Some(path) = socket_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Another Marpora answering keeps the socket; a stale file left by a crash goes.
    if UnixStream::connect(&path).is_ok() {
        eprintln!("agent socket {} is in use", path.display());
        return;
    }
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("could not listen on {}: {e}", path.display());
            return;
        }
    };
    // Only this user may drive the editor.
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let Ok(reader) = stream.try_clone() else {
                    return;
                };
                let mut writer = stream;
                for line in BufReader::new(reader).lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let reply = match serde_json::from_str::<Request>(&line) {
                        Ok(req) => match call(&app, &req.method, req.params, &req.client) {
                            Ok(result) => json!({ "result": result }),
                            Err(error) => json!({ "error": error }),
                        },
                        Err(e) => json!({ "error": format!("bad request: {e}") }),
                    };
                    if writeln!(writer, "{reply}").is_err() {
                        break;
                    }
                }
            });
        }
    });
}

#[cfg(not(unix))]
pub fn serve(_app: &AppHandle) {}

#[derive(Deserialize)]
struct Request {
    method: String,
    #[serde(default)]
    params: Value,
    /// The MCP client's name, when it gave one.
    #[serde(default)]
    client: String,
}

type Result<T> = std::result::Result<T, String>;

fn call(app: &AppHandle, method: &str, params: Value, client: &str) -> Result<Value> {
    match method {
        "list_documents" => Ok(list(app)),
        "read_document" => read(app, &params),
        "get_outline" => outline_of(app, &params),
        "get_selection" => selection(app, &params),
        "edit_document" => edit(app, &params, client),
        "write_document" => write(app, &params, client),
        "open_file" => open_file(app, &params),
        "create_document" => create(app, &params),
        "save_document" => save(app, &params),
        _ => Err(format!("unknown method {method}")),
    }
}

/// Document windows, front one first, as `(label, id)`.
fn windows(app: &AppHandle) -> Vec<(String, u64)> {
    let docs = app.state::<Docs>();
    let front = FOCUSED.lock().unwrap().clone();
    let mut out: Vec<(String, u64)> = app
        .webview_windows()
        .into_keys()
        .filter_map(|label| docs.for_window(&label).map(|id| (label, id)))
        .collect();
    out.sort_by_key(|(label, id)| (Some(label) != front.as_ref(), *id));
    out
}

/// The document `params.document` names, by id or path; the front one when it names
/// none. Returns its window and id.
fn target(app: &AppHandle, params: &Value) -> Result<(String, u64)> {
    let all = windows(app);
    let docs = app.state::<Docs>();
    match params.get("document") {
        None | Some(Value::Null) => all
            .into_iter()
            .next()
            .ok_or_else(|| "no document is open".into()),
        Some(Value::Number(n)) => {
            let id = n.as_u64().ok_or("document ids are whole numbers")?;
            all.into_iter()
                .find(|(_, d)| *d == id)
                .ok_or_else(|| format!("no open document has id {id}"))
        }
        Some(Value::String(s)) => {
            if let Ok(id) = s.parse::<u64>()
                && let Some(found) = all.iter().find(|(_, d)| *d == id)
            {
                return Ok(found.clone());
            }
            let path = std::fs::canonicalize(s).unwrap_or_else(|_| PathBuf::from(s));
            let label = docs
                .window_for_path(&path)
                .ok_or_else(|| format!("{s} is not open; open it with open_file"))?;
            all.into_iter()
                .find(|(l, _)| *l == label)
                .ok_or_else(|| format!("{s} is not open"))
        }
        Some(_) => Err("document is an id or a path".into()),
    }
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} is required"))
}

fn list(app: &AppHandle) -> Value {
    let docs = app.state::<Docs>();
    let front = FOCUSED.lock().unwrap().clone();
    let items: Vec<Value> = windows(app)
        .into_iter()
        .filter_map(|(label, id)| {
            docs.with(id, |open| {
                json!({
                    "id": id,
                    "path": open.path.as_ref().map(|p| p.to_string_lossy()),
                    "title": crate::windows::title_for(open.path.as_deref()),
                    "unsaved": open.doc.is_dirty(),
                    "front": front.as_deref() == Some(label.as_str()),
                })
            })
        })
        .collect();
    json!(items)
}

/// The text with `\n` line endings, as agents read and write it.
fn lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn read(app: &AppHandle, params: &Value) -> Result<Value> {
    let (_, id) = target(app, params)?;
    app.state::<Docs>()
        .with(id, |open| {
            json!({
                "id": id,
                "path": open.path.as_ref().map(|p| p.to_string_lossy()),
                "version": open.doc.version(),
                "text": lf(&open.doc.text()),
            })
        })
        .ok_or_else(|| "document closed".into())
}

/// ATX and setext headings among top level blocks, as `(level, text)`.
pub fn outline(blocks: &[&str]) -> Vec<(usize, String)> {
    blocks
        .iter()
        .filter_map(|b| {
            let first = b.lines().next()?;
            let hashes = first.chars().take_while(|&c| c == '#').count();
            if (1..=6).contains(&hashes) && first[hashes..].starts_with([' ', '\t']) {
                let text = first[hashes..].trim().trim_end_matches('#').trim_end();
                return Some((hashes, text.to_owned()));
            }
            let mut lines = b.lines();
            let (text, under) = (lines.next()?, lines.next()?);
            let under = under.trim();
            let level = match under.chars().next()? {
                '=' if under.chars().all(|c| c == '=') => 1,
                '-' if under.chars().all(|c| c == '-') => 2,
                _ => return None,
            };
            (lines.next().is_none()).then(|| (level, text.trim().to_owned()))
        })
        .collect()
}

fn outline_of(app: &AppHandle, params: &Value) -> Result<Value> {
    let (_, id) = target(app, params)?;
    let headings = app
        .state::<Docs>()
        .with(id, |open| {
            let blocks: Vec<&str> = open.doc.blocks().iter().map(|b| b.text.as_str()).collect();
            outline(&blocks)
        })
        .ok_or("document closed")?;
    Ok(json!(
        headings
            .into_iter()
            .map(|(level, text)| json!({ "level": level, "text": text }))
            .collect::<Vec<_>>()
    ))
}

fn selection(app: &AppHandle, params: &Value) -> Result<Value> {
    let (_, id) = target(app, params)?;
    let sel = SELECTIONS
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(&id).cloned());
    let Some(sel) = sel else {
        return Ok(json!({ "id": id, "text": "", "markdown": "" }));
    };
    let markdown = app
        .state::<Docs>()
        .with(id, |open| {
            let blocks = open.doc.blocks();
            let end = (sel.end_block + 1).min(blocks.len());
            let start = sel.start_block.min(end);
            blocks[start..end]
                .iter()
                .map(|b| lf(&b.text))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .ok_or("document closed")?;
    // `markdown` is the source of the whole blocks the selection touches, which an
    // edit can quote; `text` is what is selected, as shown.
    Ok(json!({ "id": id, "text": sel.text, "markdown": markdown }))
}

/// `text` with `old` replaced by `new`: every occurrence when `all`, else the only
/// one. Returns the text and the count.
pub fn replace(text: &str, old: &str, new: &str, all: bool) -> Result<(String, usize)> {
    if old.is_empty() {
        return Err("old_text is empty".into());
    }
    let count = text.matches(old).count();
    match (count, all) {
        (0, _) => Err("old_text was not found in the document; read it again".into()),
        (1, _) | (_, true) => Ok((text.replace(old, new), count)),
        (n, false) => Err(format!(
            "old_text occurs {n} times; quote more of the text around it, or set replace_all"
        )),
    }
}

/// Make `text` the document's, in the editor too. Returns the new version.
fn apply(app: &AppHandle, label: &str, id: u64, text: &str) -> Result<u64> {
    let flavor = app.state::<Store>().get().flavor;
    let (patch, version) = app
        .state::<Docs>()
        .with(id, |open| {
            let text = match open.doc.crlf() {
                true => lf(text).replace('\n', "\r\n"),
                false => text.to_owned(),
            };
            let patch = open.doc.replace_text(&text, &flavor);
            (patch, open.doc.version())
        })
        .ok_or("document closed")?;
    if let Some(patch) = patch {
        let _ = app.emit_to(
            label,
            "remote-patch",
            crate::watch::RemotePatchEvent { doc_id: id, patch },
        );
        app.state::<Autosave>().touch(id);
    }
    Ok(version)
}

fn current_text(app: &AppHandle, id: u64) -> Result<String> {
    app.state::<Docs>()
        .with(id, |open| lf(&open.doc.text()))
        .ok_or_else(|| "document closed".into())
}

/// An edit an agent asked for, which can be made again on newer text.
enum Change {
    Replace { old: String, new: String, all: bool },
    Write(String),
}

impl Change {
    /// The text after the change, and the number of replacements.
    fn on(&self, text: &str) -> Result<(String, usize)> {
        match self {
            Change::Replace { old, new, all } => replace(text, old, new, *all),
            Change::Write(new) => Ok((lf(new), 1)),
        }
    }
}

fn edit(app: &AppHandle, params: &Value, client: &str) -> Result<Value> {
    let (label, id) = target(app, params)?;
    let change = Change::Replace {
        old: lf(str_param(params, "old_text")?),
        new: lf(str_param(params, "new_text")?),
        all: params
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    make(app, &label, id, &change, client)
}

fn write(app: &AppHandle, params: &Value, client: &str) -> Result<Value> {
    let (label, id) = target(app, params)?;
    let change = Change::Write(str_param(params, "text")?.to_owned());
    make(app, &label, id, &change, client)
}

/// Make `change`, at once or when the user accepts it.
fn make(app: &AppHandle, label: &str, id: u64, change: &Change, client: &str) -> Result<Value> {
    let settings = app.state::<Store>().get();
    let ask =
        settings.agent_edits == "suggest" && !settings.agents_trusted.iter().any(|a| a == client);
    if ask {
        let current = current_text(app, id)?;
        let (text, replacements) = change.on(&current)?;
        if text == current {
            return Ok(json!({ "id": id, "replacements": replacements, "changed": false }));
        }
        let (line, removed, added) = hunk(&current, &text);
        let suggestion = Suggestion {
            id: NEXT_SUGGESTION.fetch_add(1, Ordering::Relaxed),
            doc_id: id,
            agent: client.to_owned(),
            line,
            removed,
            added,
        };
        if !wait_for_user(app, label, &suggestion) {
            return Err(
                "The user declined this edit in Marpora; the document is unchanged.".into(),
            );
        }
    }
    // On the text as it is now: the user may have typed while deciding.
    let (text, replacements) = change.on(&current_text(app, id)?)?;
    let version = apply(app, label, id, &text)?;
    Ok(json!({ "id": id, "version": version, "replacements": replacements }))
}

/// An edit shown to the user (the "agent-suggestion" event): the lines it changes, from
/// line `line` (1-based).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Suggestion {
    id: u64,
    doc_id: u64,
    agent: String,
    line: usize,
    removed: String,
    added: String,
}

static NEXT_SUGGESTION: AtomicU64 = AtomicU64::new(1);

/// Suggestions waiting for the user, by id.
#[derive(Default)]
pub struct Suggestions(Mutex<HashMap<u64, mpsc::Sender<bool>>>);

/// How long an agent's edit waits for the user before it is dropped.
const ANSWER_TIME: Duration = Duration::from_secs(600);

/// Show `suggestion` in the document's window and wait for the user's answer: true
/// when they accept it.
fn wait_for_user(app: &AppHandle, label: &str, suggestion: &Suggestion) -> bool {
    let (tx, rx) = mpsc::channel();
    let pending = &app.state::<Suggestions>().0;
    pending.lock().unwrap().insert(suggestion.id, tx);
    let _ = app.emit_to(label, "agent-suggestion", suggestion);
    let accepted = rx.recv_timeout(ANSWER_TIME).unwrap_or(false);
    pending.lock().unwrap().remove(&suggestion.id);
    // Gone from the window too when it timed out.
    let _ = app.emit_to(label, "agent-suggestion-done", suggestion.id);
    accepted
}

/// The user's answer to suggestion `id`; with `trust`, its agent's edits apply at once
/// from now on.
#[tauri::command]
pub fn agent_answer(
    app: AppHandle,
    id: u64,
    accept: bool,
    trust: Option<String>,
    pending: tauri::State<Suggestions>,
) {
    if let Some(agent) = trust.filter(|a| !a.is_empty()) {
        app.state::<Store>().update(&app, |s| {
            if !s.agents_trusted.contains(&agent) {
                s.agents_trusted.push(agent);
            }
        });
    }
    if let Some(tx) = pending.0.lock().unwrap().remove(&id) {
        let _ = tx.send(accept);
    }
}

/// Where `new` differs from `old`, by whole lines: the first changed line (1-based),
/// and the lines taken out and put in.
pub fn hunk(old: &str, new: &str) -> (usize, String, String) {
    let a: Vec<&str> = old.split_inclusive('\n').collect();
    let b: Vec<&str> = new.split_inclusive('\n').collect();
    let head = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let tail = a[head..]
        .iter()
        .rev()
        .zip(b[head..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    (
        head + 1,
        a[head..a.len() - tail].concat(),
        b[head..b.len() - tail].concat(),
    )
}

/// Run `f` on the main thread, where windows are made, and wait for it.
fn on_main<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> R + Send + 'static,
) -> Result<R> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&handle));
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "the editor did not answer".into())
}

fn opened(app: &AppHandle, path: &Path) -> Result<Value> {
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let docs = app.state::<Docs>();
    let id = docs
        .window_for_path(&path)
        .and_then(|label| docs.for_window(&label))
        .ok_or("the document did not open")?;
    Ok(json!({ "id": id, "path": path.to_string_lossy() }))
}

fn open_file(app: &AppHandle, params: &Value) -> Result<Value> {
    let path = PathBuf::from(str_param(params, "path")?);
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let p = path.clone();
    on_main(app, move |app| crate::windows::open(app, Some(p)))?.map_err(|e| e.to_string())?;
    opened(app, &path)
}

fn create(app: &AppHandle, params: &Value) -> Result<Value> {
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    match params.get("path").and_then(Value::as_str) {
        Some(path) => {
            let path = PathBuf::from(path);
            if path.exists() {
                return Err(format!("{} exists; use open_file", path.display()));
            }
            crate::save::write_atomically(&path, text)
                .map_err(|e| format!("could not write {}: {e}", path.display()))?;
            let p = path.clone();
            on_main(app, move |app| crate::windows::open(app, Some(p)))?
                .map_err(|e| e.to_string())?;
            opened(app, &path)
        }
        None => {
            let before: Vec<u64> = windows(app).into_iter().map(|(_, id)| id).collect();
            let text = text.to_owned();
            on_main(app, move |app| crate::windows::open_text(app, &text))?
                .map_err(|e| e.to_string())?;
            let id = windows(app)
                .into_iter()
                .map(|(_, id)| id)
                .find(|id| !before.contains(id))
                .ok_or("the document did not open")?;
            Ok(json!({ "id": id, "path": null }))
        }
    }
}

fn save(app: &AppHandle, params: &Value) -> Result<Value> {
    let (label, id) = target(app, params)?;
    let path = app
        .state::<Docs>()
        .with(id, |open| open.path.clone())
        .ok_or("document closed")?
        .ok_or("the document is untitled; the user saves it, or create it with a path")?;
    // Through the editor, which first sends what is typed but not yet synced.
    let _ = app.emit_to(&label, "menu", "save");
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let dirty = app.state::<Docs>().with(id, |open| open.doc.is_dirty());
        if dirty == Some(false) {
            return Ok(json!({ "id": id, "path": path.to_string_lossy() }));
        }
    }
    Err("the editor did not save in time".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunk_is_the_changed_lines() {
        assert_eq!(
            hunk("a\nb\nc\nd\n", "a\nB\nB2\nd\n"),
            (2, "b\nc\n".to_owned(), "B\nB2\n".to_owned())
        );
        assert_eq!(
            hunk("a\nb", "a\nb\nc"),
            (2, "b".to_owned(), "b\nc".to_owned())
        );
        assert_eq!(hunk("same\n", "same\n"), (2, String::new(), String::new()));
    }

    #[test]
    fn changes_apply_to_newer_text() {
        let change = Change::Replace {
            old: "two".into(),
            new: "2".into(),
            all: false,
        };
        assert_eq!(change.on("one two").unwrap(), ("one 2".to_owned(), 1));
        assert!(change.on("one three").is_err());
    }

    #[test]
    fn replace_needs_one_match_unless_all() {
        assert_eq!(
            replace("a b a", "b", "c", false).unwrap(),
            ("a c a".into(), 1)
        );
        assert!(
            replace("a b a", "a", "c", false)
                .unwrap_err()
                .contains("2 times")
        );
        assert_eq!(
            replace("a b a", "a", "c", true).unwrap(),
            ("c b c".into(), 2)
        );
        assert!(replace("a", "z", "c", false).is_err());
        assert!(replace("a", "", "c", false).is_err());
    }

    #[test]
    fn outline_finds_atx_and_setext_headings() {
        let blocks = [
            "# One #",
            "text",
            "Two\n---",
            "#nope",
            "###### Six",
            "a\nb\n===",
            "Big\n===",
        ];
        assert_eq!(
            outline(&blocks),
            vec![
                (1, "One".to_owned()),
                (2, "Two".to_owned()),
                (6, "Six".to_owned()),
                (1, "Big".to_owned())
            ]
        );
    }
}
