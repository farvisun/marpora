//! The user's Claude Code and Codex CLIs as models, signed in as the user: the prompt
//! goes in on stdin and JSON events come out, one a line.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::{Error, Request, Role};

/// Where CLIs are installed besides `PATH`, which is short for apps opened from the
/// Finder.
fn search_path() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.extend([
            home.join(".local/bin"),
            home.join(".claude/local"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
        ]);
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs
}

fn command(name: &str) -> Result<Command, Error> {
    let dirs = search_path();
    let program = dirs
        .iter()
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| {
            Error::Cli(format!(
                "the {name} command was not found; install it, or pick another provider"
            ))
        })?;
    let mut cmd = Command::new(program);
    // Node-based CLIs find `node` on PATH.
    cmd.env("PATH", std::env::join_paths(dirs).unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok(cmd)
}

/// The conversation as one prompt: the last message alone, or a transcript.
pub(crate) fn transcript(request: &Request) -> String {
    match request.messages.as_slice() {
        [only] => only.content.clone(),
        all => all
            .iter()
            .map(|m| {
                let who = if m.role == Role::User {
                    "User"
                } else {
                    "Assistant"
                };
                format!("{who}: {}", m.content)
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}

/// Run `cmd` with `prompt` on stdin, passing each stdout line to `line`, which returns
/// the answer once it has it.
async fn run(
    mut cmd: Command,
    prompt: &str,
    mut line: impl FnMut(&str) -> Option<Result<String, Error>>,
) -> Result<String, Error> {
    let mut child = cmd.spawn().map_err(|e| Error::Cli(e.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| Error::Cli("no stdin".into()))?;
    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| Error::Cli(e.to_string()))?;
    drop(stdin);
    let mut stderr = child.stderr.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Cli("no stdout".into()))?;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(l) = lines
        .next_line()
        .await
        .map_err(|e| Error::Cli(e.to_string()))?
    {
        if let Some(done) = line(&l) {
            let _ = child.kill().await;
            return done;
        }
    }
    let mut err = String::new();
    if let Some(e) = stderr.as_mut() {
        let _ = e.read_to_string(&mut err).await;
    }
    let status = child.wait().await.map_err(|e| Error::Cli(e.to_string()))?;
    Err(Error::Cli(match err.trim() {
        "" => format!("the command ended ({status}) without an answer"),
        e => e.lines().take(5).collect::<Vec<_>>().join("\n"),
    }))
}

/// One line of `claude -p --output-format stream-json`: text to show, or the end.
pub(crate) fn claude_line(
    line: &str,
    on_text: &mut dyn FnMut(&str),
) -> Option<Result<String, Error>> {
    let v: Value = serde_json::from_str(line).ok()?;
    match v["type"].as_str()? {
        "stream_event" => {
            let event = &v["event"];
            if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                on_text(event["delta"]["text"].as_str().unwrap_or(""));
            }
            None
        }
        "result" => {
            let text = v["result"].as_str().unwrap_or("").to_owned();
            Some(match v["is_error"].as_bool().unwrap_or(false) {
                true => Err(Error::Cli(text)),
                false => Ok(text),
            })
        }
        _ => None,
    }
}

pub(crate) async fn claude(
    model: &str,
    request: &Request,
    folder: Option<&Path>,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<String, Error> {
    let mut cmd = command("claude")?;
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // None of the user's hooks, CLAUDE.md or MCP servers. A plain text task gets
        // no tools; a chat about the folder runs in it and may only read.
        "--tools",
        if folder.is_some() {
            "Read,Grep,Glob"
        } else {
            ""
        },
        "--safe-mode",
        "--no-session-persistence",
    ]);
    if let Some(dir) = folder {
        cmd.current_dir(dir);
    }
    if !request.system.is_empty() {
        cmd.args(["--system-prompt", &request.system]);
    }
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    run(cmd, &transcript(request), |l| claude_line(l, on_text)).await
}

/// One line of `codex exec --json`: the agent's message arrives whole.
pub(crate) fn codex_line(
    line: &str,
    on_text: &mut dyn FnMut(&str),
    answer: &mut String,
) -> Option<Result<String, Error>> {
    let v: Value = serde_json::from_str(line).ok()?;
    match v["type"].as_str()? {
        "item.completed" if v["item"]["type"] == "agent_message" => {
            let text = v["item"]["text"].as_str().unwrap_or("");
            on_text(text);
            answer.push_str(text);
            None
        }
        "turn.completed" => Some(Ok(std::mem::take(answer))),
        "turn.failed" => Some(Err(Error::Cli(
            v["error"]["message"]
                .as_str()
                .unwrap_or("Codex failed")
                .to_owned(),
        ))),
        "error" => Some(Err(Error::Cli(
            v["message"].as_str().unwrap_or("Codex failed").to_owned(),
        ))),
        _ => None,
    }
}

pub(crate) async fn codex(
    model: &str,
    request: &Request,
    folder: Option<&Path>,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<String, Error> {
    let mut cmd = command("codex")?;
    cmd.args([
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
    ]);
    // A chat about the folder works in it (still read-only).
    if let Some(dir) = folder {
        cmd.arg("--cd").arg(dir);
    }
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    cmd.arg("-");
    // Codex takes no system prompt; it leads the prompt instead.
    let prompt = match request.system.as_str() {
        "" => transcript(request),
        system => format!("{system}\n\n---\n\n{}", transcript(request)),
    };
    let mut answer = String::new();
    run(cmd, &prompt, |l| codex_line(l, on_text, &mut answer)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Message;

    #[test]
    fn claude_stream_json() {
        let mut got = String::new();
        {
            let mut on = |t: &str| got.push_str(t);
            assert!(claude_line(r#"{"type":"system","subtype":"init"}"#, &mut on).is_none());
            let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}"#;
            assert!(claude_line(delta, &mut on).is_none());
            let result = r#"{"type":"result","subtype":"success","is_error":false,"result":"Hi"}"#;
            assert_eq!(claude_line(result, &mut on).unwrap().unwrap(), "Hi");
            let failed = r#"{"type":"result","is_error":true,"result":"Not logged in"}"#;
            assert!(claude_line(failed, &mut on).unwrap().is_err());
        }
        assert_eq!(got, "Hi");
    }

    #[test]
    fn codex_json() {
        let mut got = String::new();
        let mut answer = String::new();
        {
            let mut on = |t: &str| got.push_str(t);
            let started = r#"{"type":"thread.started","thread_id":"x"}"#;
            assert!(codex_line(started, &mut on, &mut answer).is_none());
            let item = r#"{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"Done."}}"#;
            assert!(codex_line(item, &mut on, &mut answer).is_none());
            let done = codex_line(
                r#"{"type":"turn.completed","usage":{}}"#,
                &mut on,
                &mut answer,
            );
            assert_eq!(done.unwrap().unwrap(), "Done.");
        }
        assert_eq!(got, "Done.");
    }

    #[test]
    fn transcripts() {
        let one = Request {
            messages: vec![Message {
                role: Role::User,
                content: "a".into(),
            }],
            ..Request::default()
        };
        assert_eq!(transcript(&one), "a");
        let two = Request {
            messages: vec![
                Message {
                    role: Role::User,
                    content: "a".into(),
                },
                Message {
                    role: Role::Assistant,
                    content: "b".into(),
                },
                Message {
                    role: Role::User,
                    content: "c".into(),
                },
            ],
            ..Request::default()
        };
        assert_eq!(transcript(&two), "User: a\n\nAssistant: b\n\nUser: c");
    }
}
