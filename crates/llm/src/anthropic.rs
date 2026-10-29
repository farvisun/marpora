//! The Anthropic Messages API, streamed (raw HTTP: there is no Rust SDK).

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::{Error, Request, error_text, sse};

const VERSION: &str = "2026-10-21";
/// Server-side fallback: a request a model's safeguards decline is retried on the
/// model Anthropic recommends for that case.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// The request body for `request`.
pub(crate) fn body(model: &str, request: &Request) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": 64000,
        "stream": true,
        "fallbacks": "default",
        "messages": request.messages,
    });
    if !request.system.is_empty() {
        // The system prompt holds the document, which stays the same across a
        // conversation's turns: cache it.
        body["system"] = json!([{
            "type": "text",
            "text": request.system,
            "cache_control": { "type": "ephemeral" },
        }]);
    }
    if !request.effort.is_empty() {
        body["output_config"] = json!({ "effort": request.effort });
    }
    body
}

/// What one streamed event means for the answer.
#[derive(Debug)]
pub(crate) enum Step {
    Text(String),
    Done,
    Fail(Error),
    Nothing,
}

pub(crate) fn step(data: &str) -> Step {
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return Step::Nothing;
    };
    match v["type"].as_str() {
        // Text only: thinking and the fallback marker stay out of the answer.
        Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
            Step::Text(v["delta"]["text"].as_str().unwrap_or("").to_owned())
        }
        Some("message_delta") => match v["delta"]["stop_reason"].as_str() {
            Some("refusal") => Step::Fail(Error::Refused),
            _ => Step::Nothing,
        },
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

pub(crate) async fn stream(
    api_key: &str,
    model: &str,
    base_url: &str,
    request: &Request,
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
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .body(body(model, request).to_string())
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(Error::Api(error_text(status, &text)));
    }
    let mut parser = sse::Parser::default();
    let mut answer = String::new();
    let mut bytes = response.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        for event in parser.feed(&chunk?) {
            match step(&event.data) {
                Step::Text(t) => {
                    on_text(&t);
                    answer.push_str(&t);
                }
                Step::Done => return Ok(answer),
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
        let b = body("claude-opus-5-5", &request);
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["output_config"]["effort"], "low");
        assert!(body("m", &Request::default()).get("system").is_none());
    }

    #[test]
    fn steps_through_a_stream() {
        let show = |data: &str| format!("{:?}", step(data));
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
}
