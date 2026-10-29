//! Any OpenAI-compatible chat completions endpoint (OpenAI, OpenRouter, a local
//! server), streamed.

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::{Error, FolderTools, MAX_TOOL_ROUNDS, Request, error_text, folder_tools, sse};

/// The conversation as the endpoint takes it: the system prompt first.
pub(crate) fn messages(request: &Request) -> Vec<Value> {
    let mut messages = Vec::new();
    if !request.system.is_empty() {
        messages.push(json!({ "role": "system", "content": request.system }));
    }
    messages.extend(
        request
            .messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content })),
    );
    messages
}

pub(crate) fn body(model: &str, messages: &[Value], tools: bool) -> Value {
    let mut body = json!({ "model": model, "stream": true, "messages": messages });
    if tools {
        body["tools"] = folder_tools()
            .into_iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
            .collect();
    }
    body
}

/// A tool call being streamed.
#[derive(Default, Debug)]
pub(crate) struct Call {
    id: String,
    name: String,
    arguments: String,
}

/// One response being streamed: its tool calls, and why it ended.
#[derive(Default)]
pub(crate) struct Turn {
    pub(crate) calls: Vec<Call>,
    pub(crate) finish: Option<String>,
}

impl Turn {
    /// The text a streamed chunk adds; None at `[DONE]`.
    pub(crate) fn delta(&mut self, data: &str) -> Option<Result<String, Error>> {
        if data.trim() == "[DONE]" {
            return None;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Some(Ok(String::new()));
        };
        if let Some(message) = v["error"]["message"].as_str() {
            return Some(Err(Error::Api(message.to_owned())));
        }
        let choice = &v["choices"][0];
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish = Some(reason.to_owned());
        }
        for call in choice["delta"]["tool_calls"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let i = call["index"].as_u64().unwrap_or(0) as usize;
            if self.calls.len() <= i {
                self.calls.resize_with(i + 1, Call::default);
            }
            let c = &mut self.calls[i];
            if let Some(id) = call["id"].as_str() {
                c.id = id.to_owned();
            }
            if let Some(name) = call["function"]["name"].as_str() {
                c.name.push_str(name);
            }
            c.arguments
                .push_str(call["function"]["arguments"].as_str().unwrap_or(""));
        }
        Some(Ok(choice["delta"]["content"]
            .as_str()
            .unwrap_or("")
            .to_owned()))
    }

    /// The assistant turn with its calls, then one tool message per call, run on
    /// `folder`.
    pub(crate) fn next_messages(&self, text: &str, folder: &dyn FolderTools) -> Vec<Value> {
        let calls: Vec<Value> = self
            .calls
            .iter()
            .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments } }))
            .collect();
        let content = if text.is_empty() {
            Value::Null
        } else {
            json!(text)
        };
        let mut out = vec![json!({ "role": "assistant", "content": content, "tool_calls": calls })];
        for c in &self.calls {
            let result = match serde_json::from_str::<Value>(if c.arguments.trim().is_empty() {
                "{}"
            } else {
                &c.arguments
            }) {
                Ok(input) if input.is_object() => folder.call(&c.name, &input),
                _ => Err(json!({ "INVALID_JSON": c.arguments }).to_string()),
            };
            let content = result.unwrap_or_else(|e| format!("Error: {e}"));
            out.push(json!({ "role": "tool", "tool_call_id": c.id, "content": content }));
        }
        out
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
    let base = base_url.trim_end_matches('/');
    if base.is_empty() {
        return Err(Error::Api(
            "no endpoint; set one in Preferences › AI".into(),
        ));
    }
    let mut messages = messages(request);
    let mut answer = String::new();
    for _ in 0..MAX_TOOL_ROUNDS {
        let mut turn = Turn::default();
        let mut text = String::new();
        let gap = !answer.is_empty();
        let mut on_piece = |t: &str| {
            // Text after a tool call starts a new paragraph.
            if gap && text.is_empty() {
                on_text("\n\n");
                answer.push_str("\n\n");
            }
            on_text(t);
            answer.push_str(t);
            text.push_str(t);
        };
        send(
            api_key,
            base,
            &body(model, &messages, folder.is_some()),
            &mut turn,
            &mut on_piece,
        )
        .await?;
        let Some(folder) = folder.filter(|_| !turn.calls.is_empty()) else {
            return Ok(answer);
        };
        // A response cut off mid-call never runs its tools.
        if turn.finish.as_deref() == Some("length") {
            return Err(Error::Api("the answer was cut off".into()));
        }
        messages.extend(turn.next_messages(&text, folder));
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
    let mut call = reqwest::Client::new()
        .post(format!("{base}/chat/completions"))
        .header("content-type", "application/json")
        .body(body.to_string());
    // Local servers often need no key.
    if !api_key.is_empty() {
        call = call.bearer_auth(api_key);
    }
    let response = call.send().await?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(Error::Api(error_text(status, &text)));
    }
    let mut parser = sse::Parser::default();
    let mut bytes = response.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        for event in parser.feed(&chunk?) {
            match turn.delta(&event.data) {
                None => return Ok(()),
                Some(Ok(t)) if !t.is_empty() => on_text(&t),
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e),
            }
        }
    }
    // Some servers end the stream without `[DONE]`.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Message, Role};

    #[test]
    fn body_puts_the_system_prompt_first() {
        let request = Request {
            system: "doc".into(),
            messages: vec![Message {
                role: Role::Assistant,
                content: "a".into(),
            }],
            effort: String::new(),
        };
        let b = body("gpt", &messages(&request), false);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["role"], "assistant");
        assert!(b.get("tools").is_none());
        assert_eq!(
            body("gpt", &[], true)["tools"][2]["function"]["name"],
            "read_file"
        );
    }

    #[test]
    fn deltas() {
        let mut turn = Turn::default();
        assert_eq!(
            turn.delta(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#)
                .unwrap()
                .unwrap(),
            "Hi"
        );
        assert_eq!(
            turn.delta(r#"{"choices":[{"delta":{}}]}"#)
                .unwrap()
                .unwrap(),
            ""
        );
        assert!(turn.delta("[DONE]").is_none());
        assert!(
            turn.delta(r#"{"error":{"message":"bad"}}"#)
                .unwrap()
                .is_err()
        );
    }

    struct Folder;
    impl FolderTools for Folder {
        fn root(&self) -> &std::path::Path {
            std::path::Path::new("/notes")
        }
        fn call(&self, name: &str, input: &Value) -> Result<String, String> {
            Ok(format!("{name} {}", crate::string_arg(input, "path")?))
        }
    }

    #[test]
    fn tool_calls_become_messages() {
        let mut turn = Turn::default();
        for data in [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.md\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        ] {
            turn.delta(data);
        }
        assert_eq!(turn.finish.as_deref(), Some("tool_calls"));
        let next = turn.next_messages("", &Folder);
        assert_eq!(next[0]["content"], Value::Null);
        assert_eq!(
            next[0]["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"a.md"}"#
        );
        assert_eq!(
            next[1],
            json!({ "role": "tool", "tool_call_id": "c1", "content": "read_file a.md" })
        );
    }
}
