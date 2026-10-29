//! Language models for Marpora's AI features, streamed: the Anthropic Messages API,
//! any OpenAI-compatible chat endpoint, and the user's Claude Code or Codex CLI.

mod anthropic;
mod cli;
mod openai;
pub mod sse;
mod tools;

pub use tools::{FolderTools, ToolSpec, folder_tools, string_arg};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// What to ask: a system prompt (stable, so it caches) and the conversation.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Request {
    pub system: String,
    pub messages: Vec<Message>,
    /// "low", "medium" or "high"; the provider's default when empty.
    #[serde(default)]
    pub effort: String,
}

/// Where requests go.
#[derive(Clone, Debug)]
pub enum Provider {
    Anthropic {
        api_key: String,
        model: String,
        /// The API's address; `https://api.anthropic.com` when empty.
        base_url: String,
    },
    OpenAi {
        api_key: String,
        model: String,
        /// Up to `/v1`, such as `https://api.openai.com/v1` or a local server's.
        base_url: String,
    },
    /// The `claude` CLI, signed in as the user.
    ClaudeCode { model: String },
    /// The `codex` CLI, signed in as the user.
    Codex { model: String },
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Http(String),
    #[error("the model declined this request")]
    Refused,
    #[error("{0}")]
    Api(String),
    #[error("{0}")]
    Cli(String),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e.to_string())
    }
}

/// Run `request` on `provider`, calling `on_text` with each piece of the answer as it
/// arrives. With `folder`, the model may search and read the files in it. Returns the
/// whole answer. Dropping the future stops the request (and kills a CLI it started).
pub async fn stream(
    provider: &Provider,
    request: &Request,
    folder: Option<&dyn FolderTools>,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<String, Error> {
    let with_note;
    let request = match folder {
        Some(_) => {
            with_note = Request {
                system: format!("{}\n\n{}", request.system, tools::FOLDER_NOTE)
                    .trim_start()
                    .to_owned(),
                ..request.clone()
            };
            &with_note
        }
        None => request,
    };
    match provider {
        Provider::Anthropic {
            api_key,
            model,
            base_url,
        } => anthropic::stream(api_key, model, base_url, request, folder, on_text).await,
        Provider::OpenAi {
            api_key,
            model,
            base_url,
        } => openai::stream(api_key, model, base_url, request, folder, on_text).await,
        Provider::ClaudeCode { model } => {
            cli::claude(model, request, folder.map(|f| f.root()), on_text).await
        }
        Provider::Codex { model } => {
            cli::codex(model, request, folder.map(|f| f.root()), on_text).await
        }
    }
}

/// Tool calls a single answer may make before it has to stop.
const MAX_TOOL_ROUNDS: usize = 16;

/// The text of an error response: its `error.message` when JSON, else the body.
fn error_text(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| body.trim().chars().take(300).collect());
    format!("{status}: {message}")
}
