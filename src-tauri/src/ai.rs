//! AI requests from the editor, to the model picked in Preferences › AI, streamed back
//! to the window that asked as "ai" events: pieces of text, then the whole answer or
//! an error. API keys live in the Keychain, never in settings.json.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use marpora_llm::{Provider, Request};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::settings::{Settings, Store};

/// The model when the user picked none: the Anthropic default.
pub const ANTHROPIC_MODEL: &str = "claude-opus-5-5";
const OPENAI_URL: &str = "https://api.openai.com/v1";

/// Requests running, by window and request id, to stop on demand.
#[derive(Default)]
pub struct Tasks(Mutex<HashMap<(String, u64), tauri::async_runtime::JoinHandle<()>>>);

type CmdResult<T> = Result<T, String>;

#[cfg(target_os = "macos")]
fn entry(provider: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("app.marpora.editor", &format!("{provider}-api-key")).ok()
}

/// The API key saved for `provider` ("anthropic" or "openai"); empty when none.
fn key(provider: &str) -> String {
    #[cfg(target_os = "macos")]
    return entry(provider)
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default();
    #[cfg(not(target_os = "macos"))]
    {
        let _ = provider;
        String::new()
    }
}

fn provider(settings: &Settings) -> CmdResult<Provider> {
    let model = settings.ai_model.trim().to_owned();
    Ok(match settings.ai_provider.as_str() {
        "anthropic" => Provider::Anthropic {
            api_key: key("anthropic"),
            model: if model.is_empty() {
                ANTHROPIC_MODEL.to_owned()
            } else {
                model
            },
            base_url: String::new(),
        },
        "openai" => {
            if model.is_empty() {
                return Err("choose a model in Preferences › AI".into());
            }
            let base_url = settings.ai_base_url.trim();
            Provider::OpenAi {
                api_key: key("openai"),
                model,
                base_url: if base_url.is_empty() {
                    OPENAI_URL
                } else {
                    base_url
                }
                .to_owned(),
            }
        }
        "claude-code" => Provider::ClaudeCode { model },
        "codex" => Provider::Codex { model },
        other => return Err(format!("unknown AI provider {other}")),
    })
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AiEvent {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    done: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Start request `id` for the window; its answer arrives as "ai" events.
#[tauri::command]
pub fn ai_start(
    window: WebviewWindow,
    id: u64,
    request: Request,
    store: State<Store>,
    tasks: State<Tasks>,
) -> CmdResult<()> {
    let provider = provider(&store.get())?;
    let label = window.label().to_owned();
    let target = window.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let send = |event: AiEvent| {
            let _ = target.emit_to(target.label(), "ai", event);
        };
        let mut on_text = |t: &str| {
            send(AiEvent {
                id,
                text: Some(t.to_owned()),
                ..AiEvent::default()
            });
        };
        let event = match marpora_llm::stream(&provider, &request, &mut on_text).await {
            Ok(answer) => AiEvent {
                id,
                done: Some(answer),
                ..AiEvent::default()
            },
            Err(e) => AiEvent {
                id,
                error: Some(e.to_string()),
                ..AiEvent::default()
            },
        };
        send(event);
        use tauri::Manager;
        target
            .state::<Tasks>()
            .0
            .lock()
            .unwrap()
            .remove(&(target.label().to_owned(), id));
    });
    tasks.0.lock().unwrap().insert((label, id), handle);
    Ok(())
}

/// Stop request `id` (Esc); nothing more arrives for it.
#[tauri::command]
pub fn ai_cancel(window: WebviewWindow, id: u64, tasks: State<Tasks>) {
    if let Some(task) = tasks
        .0
        .lock()
        .unwrap()
        .remove(&(window.label().to_owned(), id))
    {
        task.abort();
    }
}

/// Save (or, when empty, forget) the API key for `provider`.
#[tauri::command]
pub fn ai_set_key(provider: String, key: String) -> CmdResult<()> {
    if !matches!(provider.as_str(), "anthropic" | "openai") {
        return Err(format!("{provider} takes no key"));
    }
    #[cfg(target_os = "macos")]
    {
        let entry = entry(&provider).ok_or("the Keychain is not available")?;
        let key = key.trim();
        let result = match key.is_empty() {
            true => match entry.delete_credential() {
                Err(keyring::Error::NoEntry) => Ok(()),
                r => r,
            },
            false => entry.set_password(key),
        };
        result.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Err("saving keys is not available on this platform yet".into())
    }
}

/// Which providers have a key saved, for Preferences.
#[tauri::command]
pub fn ai_keys() -> HashMap<&'static str, bool> {
    ["anthropic", "openai"]
        .into_iter()
        .map(|p| (p, !key(p).is_empty()))
        .collect()
}

/// A custom prompt (AI › Custom Prompts): a Markdown file in `prompts_dir`, its name the
/// label and its text, without front matter, the instruction.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Prompt {
    pub name: String,
    pub instruction: String,
}

pub fn prompts_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("prompts"))
}

/// The prompts in `dir`, by name; empty and oversized files are left out.
pub fn read_prompts(dir: &Path) -> Vec<Prompt> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<Prompt> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_stem()?.to_str()?.to_owned();
            let md = path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("md"));
            if !md || name.starts_with('.') || e.metadata().ok()?.len() > 64 * 1024 {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            let instruction = without_front_matter(&text).trim().to_owned();
            (!instruction.is_empty()).then_some(Prompt { name, instruction })
        })
        .collect();
    out.sort_by_key(|p| p.name.to_lowercase());
    out
}

fn without_front_matter(text: &str) -> &str {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return text;
    };
    match rest.find("\n---") {
        Some(end) => rest[end + 4..]
            .trim_start_matches(['-', '\r'])
            .trim_start_matches('\n'),
        None => text,
    }
}

#[tauri::command]
pub fn ai_prompts(app: AppHandle) -> Vec<Prompt> {
    prompts_dir(&app)
        .map(|d| read_prompts(&d))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_are_the_markdown_files() {
        let dir = std::env::temp_dir().join(format!("marpora-prompts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("Make Formal.md"),
            "---\ntitle: x\n---\nRewrite it formally.\n",
        )
        .unwrap();
        std::fs::write(dir.join("bullets.md"), "  Turn it into a bulleted list.\n").unwrap();
        std::fs::write(dir.join("empty.md"), "\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "not a prompt").unwrap();
        let prompts = read_prompts(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        let got: Vec<(&str, &str)> = prompts
            .iter()
            .map(|p| (p.name.as_str(), p.instruction.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("bullets", "Turn it into a bulleted list."),
                ("Make Formal", "Rewrite it formally.")
            ]
        );
    }
}
