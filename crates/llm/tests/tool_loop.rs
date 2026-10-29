//! The tool loops against a stand-in API on localhost: the first answer calls a tool,
//! the second answers in text after seeing the tool's result.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

use marpora_llm::{FolderTools, Message, Provider, Request, Role, stream, string_arg};
use serde_json::Value;

/// Serve `responses` (SSE bodies) in order, one a connection; returns the address and
/// the request bodies received.
fn serve(responses: Vec<String>) -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = format!("http://{}", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let seen = bodies.clone();
    std::thread::spawn(move || {
        for body in responses {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
                if line == "\r\n" {
                    break;
                }
            }
            let mut request = vec![0; length];
            reader.read_exact(&mut request).unwrap();
            seen.lock()
                .unwrap()
                .push(serde_json::from_slice(&request).unwrap());
            let mut stream = stream;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}"
            )
            .unwrap();
        }
    });
    (addr, bodies)
}

fn sse(events: &[&str]) -> String {
    events.iter().map(|e| format!("data: {e}\n\n")).collect()
}

struct Notes;

impl FolderTools for Notes {
    fn root(&self) -> &Path {
        Path::new("/notes")
    }
    fn call(&self, name: &str, input: &Value) -> Result<String, String> {
        assert_eq!(name, "search_files");
        Ok(format!(
            "plan.md\n  3: {} on Friday",
            string_arg(input, "query")?
        ))
    }
}

fn question() -> Request {
    Request {
        system: "You help.".into(),
        messages: vec![Message {
            role: Role::User,
            content: "When is the milk run?".into(),
        }],
        effort: String::new(),
    }
}

#[tokio::test]
async fn anthropic_runs_tools_until_it_answers() {
    let (base, bodies) = serve(vec![
        sse(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"search_files","input":{}}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"Milk run\"}"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
            r#"{"type":"message_stop"}"#,
        ]),
        sse(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"On Friday (plan.md)."}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
            r#"{"type":"message_stop"}"#,
        ]),
    ]);
    let provider = Provider::Anthropic {
        api_key: "test".into(),
        model: "m".into(),
        base_url: base,
    };
    let mut streamed = String::new();
    let answer = stream(&provider, &question(), Some(&Notes), &mut |t| {
        streamed.push_str(t)
    })
    .await
    .unwrap();
    assert_eq!(answer, "On Friday (plan.md).");
    assert_eq!(streamed, answer);
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0]["tools"][0]["name"], "search_files");
    // Through a stand-in address: the eager streaming field stays off.
    assert!(bodies[0]["tools"][0].get("eager_input_streaming").is_none());
    assert!(
        bodies[0]["system"][0]["text"]
            .as_str()
            .unwrap()
            .contains("folder")
    );
    let turns = bodies[1]["messages"].as_array().unwrap();
    assert_eq!(turns[1]["content"][0]["type"], "tool_use");
    assert_eq!(turns[2]["content"][0]["tool_use_id"], "t1");
    assert_eq!(
        turns[2]["content"][0]["content"],
        "plan.md\n  3: Milk run on Friday"
    );
}

#[tokio::test]
async fn openai_runs_tools_until_it_answers() {
    let (base, bodies) = serve(vec![
        sse(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search_files","arguments":"{\"query\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Milk run\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            "[DONE]",
        ]),
        sse(&[
            r#"{"choices":[{"delta":{"content":"On Friday."}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            "[DONE]",
        ]),
    ]);
    let provider = Provider::OpenAi {
        api_key: String::new(),
        model: "m".into(),
        base_url: base,
    };
    let answer = stream(&provider, &question(), Some(&Notes), &mut |_| {})
        .await
        .unwrap();
    assert_eq!(answer, "On Friday.");
    let bodies = bodies.lock().unwrap();
    let turns = bodies[1]["messages"].as_array().unwrap();
    assert_eq!(turns[2]["tool_calls"][0]["id"], "c1");
    assert_eq!(turns[3]["role"], "tool");
    assert_eq!(turns[3]["content"], "plan.md\n  3: Milk run on Friday");
}
