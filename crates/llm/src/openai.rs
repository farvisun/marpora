//! Any OpenAI-compatible chat completions endpoint (OpenAI, OpenRouter, a local
//! server), streamed.

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::{Error, Request, error_text, sse};

pub(crate) fn body(model: &str, request: &Request) -> Value {
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
    json!({ "model": model, "stream": true, "messages": messages })
}

/// The text a streamed chunk adds; None at `[DONE]`.
pub(crate) fn delta(data: &str) -> Option<Result<String, Error>> {
    if data.trim() == "[DONE]" {
        return None;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return Some(Ok(String::new()));
    };
    if let Some(message) = v["error"]["message"].as_str() {
        return Some(Err(Error::Api(message.to_owned())));
    }
    Some(Ok(v["choices"][0]["delta"]["content"]
        .as_str()
        .unwrap_or("")
        .to_owned()))
}

pub(crate) async fn stream(
    api_key: &str,
    model: &str,
    base_url: &str,
    request: &Request,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<String, Error> {
    let base = base_url.trim_end_matches('/');
    if base.is_empty() {
        return Err(Error::Api(
            "no endpoint; set one in Preferences › AI".into(),
        ));
    }
    let mut call = reqwest::Client::new()
        .post(format!("{base}/chat/completions"))
        .header("content-type", "application/json")
        .body(body(model, request).to_string());
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
    let mut answer = String::new();
    let mut bytes = response.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        for event in parser.feed(&chunk?) {
            match delta(&event.data) {
                None => return Ok(answer),
                Some(Ok(t)) if !t.is_empty() => {
                    on_text(&t);
                    answer.push_str(&t);
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e),
            }
        }
    }
    // Some servers end the stream without `[DONE]`.
    Ok(answer)
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
        let b = body("gpt", &request);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["role"], "assistant");
    }

    #[test]
    fn deltas() {
        assert_eq!(
            delta(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#)
                .unwrap()
                .unwrap(),
            "Hi"
        );
        assert_eq!(delta(r#"{"choices":[{"delta":{}}]}"#).unwrap().unwrap(), "");
        assert!(delta("[DONE]").is_none());
        assert!(delta(r#"{"error":{"message":"bad"}}"#).unwrap().is_err());
    }
}
