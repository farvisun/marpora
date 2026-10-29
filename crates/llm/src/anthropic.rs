//! The Anthropic Messages API, streamed (raw HTTP: there is no Rust SDK).

use std::collections::HashMap;

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::{Error, FolderTools, MAX_TOOL_ROUNDS, Request, error_text, folder_tools, sse};

const VERSION: &str = "2026-10-21";
/// Server-side fallback: a request a model's safeguards decline is retried on the
/// model Anthropic recommends for that case.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// The request body for `request`, with `messages` as the conversation so far (the
/// request's, then any tool turns) and the folder's tools when given.
pub(crate) fn body(
    model: &str,
    request: &Request,
    messages: &[Value],
    tools: Option<&[Value]>,
) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": 64000,
        "stream": true,
        "fallbacks": "default",
        "messages": messages,
    });
    if !request.system.is_empty() {
        // The system prompt holds the document, which stays the same across a
        // conversation's turns: cache it (the tools before it too).
        body["system"] = json!([{
            "type": "text",
            "text": request.system,
            "cache_control": { "type": "ephemeral" },
        }]);
    }
    if !request.effort.is_empty() {
        body["output_config"] = json!({ "effort": request.effort });
    }
    if let Some(tools) = tools {
        body["tools"] = json!(tools);
    }
    body
}

/// The folder's tools as the API takes them. Inputs stream as they are written (they
/// are checked here) unless a proxy, which may not know the field, is in between.
pub(crate) fn tool_defs(official: bool) -> Vec<Value> {
    folder_tools()
        .into_iter()
        .map(|t| {
            let mut def =
                json!({ "name": t.name, "description": t.description, "input_schema": t.schema });
            if official {
                def["eager_input_streaming"] = json!(true);
            }
            def
        })
        .collect()
}

/// What one streamed event means for the answer.
#[derive(Debug)]
pub(crate) enum Step {
    Text(String),
    Done,
    Fail(Error),
    Nothing,
}

/// One response being streamed: its text and tool calls, by content block.
#[derive(Default)]
pub(crate) struct Turn {
    blocks: Vec<Option<Value>>,
    /// Tool inputs as they arrive, by block.
    inputs: HashMap<usize, String>,
    /// Tool inputs that were not valid JSON, by block.
    invalid: HashMap<usize, String>,
    pub(crate) stop: Option<String>,
}

impl Turn {
    pub(crate) fn step(&mut self, data: &str) -> Step {
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Step::Nothing;
        };
        let index = v["index"].as_u64().unwrap_or(0) as usize;
        match v["type"].as_str() {
            Some("content_block_start") => {
                let block = &v["content_block"];
                // Text and tool calls; thinking and the fallback marker stay out.
                let kept = match block["type"].as_str() {
                    Some("text") => Some(json!({ "type": "text", "text": "" })),
                    Some("tool_use") => {
                        self.inputs.insert(index, String::new());
                        Some(
                            json!({ "type": "tool_use", "id": block["id"], "name": block["name"], "input": {} }),
                        )
                    }
                    _ => None,
                };
                if self.blocks.len() <= index {
                    self.blocks.resize(index + 1, None);
                }
                self.blocks[index] = kept;
                Step::Nothing
            }
            Some("content_block_delta") => match v["delta"]["type"].as_str() {
                Some("text_delta") => {
                    let text = v["delta"]["text"].as_str().unwrap_or("").to_owned();
                    if let Some(Some(block)) = self.blocks.get_mut(index) {
                        let joined = format!("{}{text}", block["text"].as_str().unwrap_or(""));
                        block["text"] = json!(joined);
                    }
                    Step::Text(text)
                }
                Some("input_json_delta") => {
                    if let Some(input) = self.inputs.get_mut(&index) {
                        input.push_str(v["delta"]["partial_json"].as_str().unwrap_or(""));
                    }
                    Step::Nothing
                }
                _ => Step::Nothing,
            },
            Some("content_block_stop") => {
                if let Some(raw) = self.inputs.remove(&index) {
                    // Parsed strictly: with eager streaming the API does not check it.
                    let parsed = match raw.trim() {
                        "" => Ok(json!({})),
                        text => serde_json::from_str::<Value>(text),
                    };
                    match parsed {
                        Ok(input) if input.is_object() => {
                            if let Some(Some(block)) = self.blocks.get_mut(index) {
                                block["input"] = input;
                            }
                        }
                        _ => {
                            self.invalid.insert(index, raw);
                        }
                    }
                }
                Step::Nothing
            }
            Some("message_delta") => {
                self.stop = v["delta"]["stop_reason"].as_str().map(str::to_owned);
                match self.stop.as_deref() {
                    Some("refusal") => Step::Fail(Error::Refused),
                    _ => Step::Nothing,
                }
            }
            Some("message_stop") => Step::Done,
            Some("error") => Step::Fail(Error::Api(
                v["error"]["message"]
                    .as_str()
                    .unwrap_or("the API stopped with an error")
                    .to_owned(),
            )),
            _ => Step::Nothing,
        }
    }

    /// The response as the next request's assistant turn (without empty text).
    pub(crate) fn content(&self) -> Vec<Value> {
        self.blocks
            .iter()
            .flatten()
            .filter(|b| b["type"] != "text" || b["text"].as_str().is_some_and(|t| !t.is_empty()))
            .cloned()
            .collect()
    }

    /// The tool calls' results, run on `folder`, as the next user turn's content.
    pub(crate) fn results(&self, folder: &dyn FolderTools) -> Vec<Value> {
        self.blocks
            .iter()
            .enumerate()
            .filter_map(|(i, b)| Some((i, b.as_ref()?)))
            .filter(|(_, b)| b["type"] == "tool_use")
            .map(|(i, block)| {
                let outcome = match self.invalid.get(&i) {
                    Some(raw) => Err(json!({ "INVALID_JSON": raw }).to_string()),
                    None => folder.call(block["name"].as_str().unwrap_or(""), &block["input"]),
                };
                let (content, failed) = match outcome {
                    Ok(text) => (text, false),
                    Err(e) => (e, true),
                };
                json!({ "type": "tool_result", "tool_use_id": block["id"], "content": content, "is_error": failed })
            })
            .collect()
    }

    fn calls_tools(&self) -> bool {
        self.blocks
            .iter()
            .flatten()
            .any(|b| b["type"] == "tool_use")
    }
}

pub(crate) async fn stream(
    api_key: &str,
    model: &str,
    base_url: &str,
    request: &Request,
    folder: Option<&dyn FolderTools>,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<String, Error> {
    if api_key.is_empty() {
        return Err(Error::Api(
            "no Anthropic API key; add one in Preferences › AI".into(),
        ));
    }
    let base = match base_url.trim_end_matches('/') {
        "" => "https://api.anthropic.com",
        b => b,
    };
    let tools = folder.map(|_| tool_defs(base_url.trim().is_empty()));
    let mut messages: Vec<Value> = request.messages.iter().map(|m| json!(m)).collect();
    let mut answer = String::new();
    for _ in 0..MAX_TOOL_ROUNDS {
        let body = body(model, request, &messages, tools.as_deref());
        let mut turn = Turn::default();
        let mut gap = !answer.is_empty();
        let mut on_piece = |t: &str| {
            // Text after a tool call starts a new paragraph.
            if gap && !t.is_empty() {
                gap = false;
                on_text("\n\n");
                answer.push_str("\n\n");
            }
            on_text(t);
            answer.push_str(t);
        };
        send(api_key, base, &body, &mut turn, &mut on_piece).await?;
        let Some(folder) = folder.filter(|_| turn.calls_tools()) else {
            return Ok(answer);
        };
        // A response cut off mid-call never runs its tools.
        if turn.stop.as_deref() != Some("tool_use") {
            return Err(Error::Api("the answer was cut off".into()));
        }
        messages.push(json!({ "role": "assistant", "content": turn.content() }));
        messages.push(json!({ "role": "user", "content": turn.results(folder) }));
    }
    Err(Error::Api(
        "the model looked through the folder for too long; ask something narrower".into(),
    ))
}

/// Post one request and stream its response into `turn`.
async fn send(
    api_key: &str,
    base: &str,
    body: &Value,
    turn: &mut Turn,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<(), Error> {
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(Error::Api(error_text(status, &text)));
    }
    let mut parser = sse::Parser::default();
    let mut bytes = response.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        for event in parser.feed(&chunk?) {
            match turn.step(&event.data) {
                Step::Text(t) => on_text(&t),
                Step::Done => return Ok(()),
                Step::Fail(e) => return Err(e),
                Step::Nothing => {}
            }
        }
    }
    Err(Error::Http(
        "the connection closed before the answer ended".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Message, Role};

    #[test]
    fn body_caches_the_system_prompt_and_opts_into_fallback() {
        let request = Request {
            system: "doc".into(),
            messages: vec![Message {
                role: Role::User,
                content: "hi".into(),
            }],
            effort: "low".into(),
        };
        let messages = vec![json!(request.messages[0])];
        let b = body("claude-opus-5-5", &request, &messages, None);
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["output_config"]["effort"], "low");
        assert!(b.get("tools").is_none());
        assert!(
            body("m", &Request::default(), &[], None)
                .get("system")
                .is_none()
        );
        let tools = tool_defs(true);
        let b = body("m", &request, &messages, Some(&tools));
        assert_eq!(b["tools"][0]["name"], "search_files");
        assert_eq!(b["tools"][0]["eager_input_streaming"], true);
        assert!(tool_defs(false)[0].get("eager_input_streaming").is_none());
    }

    #[test]
    fn steps_through_a_stream() {
        let mut turn = Turn::default();
        let mut show = |data: &str| format!("{:?}", turn.step(data));
        assert_eq!(
            show(
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#
            ),
            "Nothing"
        );
        assert_eq!(
            show(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#
            ),
            r#"Text("Hi")"#
        );
        assert_eq!(
            show(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"…"}}"#
            ),
            "Nothing"
        );
        assert_eq!(
            show(r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#),
            "Fail(Refused)"
        );
        assert_eq!(show(r#"{"type":"message_stop"}"#), "Done");
        assert_eq!(
            show(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#),
            r#"Fail(Api("Overloaded"))"#
        );
    }

    struct Folder;
    impl FolderTools for Folder {
        fn root(&self) -> &std::path::Path {
            std::path::Path::new("/notes")
        }
        fn call(&self, name: &str, input: &Value) -> Result<String, String> {
            Ok(format!("{name} {}", crate::string_arg(input, "query")?))
        }
    }

    #[test]
    fn tool_calls_become_the_next_turn() {
        let mut turn = Turn::default();
        for event in [
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking."}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"search_files","input":{}}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\": "}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"milk\"}"}}"#,
            r#"{"type":"content_block_stop","index":1}"#,
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t2","name":"search_files","input":{}}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"query\": \"cut"}}"#,
            r#"{"type":"content_block_stop","index":2}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
        ] {
            turn.step(event);
        }
        assert_eq!(turn.stop.as_deref(), Some("tool_use"));
        let content = turn.content();
        assert_eq!(content[0], json!({ "type": "text", "text": "Looking." }));
        assert_eq!(content[1]["input"], json!({ "query": "milk" }));
        let results = turn.results(&Folder);
        assert_eq!(
            results[0],
            json!({ "type": "tool_result", "tool_use_id": "t1", "content": "search_files milk", "is_error": false })
        );
        assert_eq!(results[1]["is_error"], true);
        assert!(
            results[1]["content"]
                .as_str()
                .unwrap()
                .contains("INVALID_JSON")
        );
    }
}
