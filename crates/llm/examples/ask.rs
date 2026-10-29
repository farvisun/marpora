//! A live check of a provider: `cargo run -p marpora-llm --example ask -- claude-code "Say hi"`.
//! Providers: claude-code, codex, anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY,
//! OPENAI_BASE_URL, MODEL). It spends the account's credit or the CLI's quota.

use marpora_llm::{Message, Provider, Request, Role, stream};
use std::io::Write;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let name = args.next().unwrap_or_else(|| "claude-code".into());
    let prompt = args
        .next()
        .unwrap_or_else(|| "Reply with one short sentence.".into());
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let provider = match name.as_str() {
        "codex" => Provider::Codex {
            model: env("MODEL"),
        },
        "anthropic" => Provider::Anthropic {
            api_key: env("ANTHROPIC_API_KEY"),
            model: std::env::var("MODEL").unwrap_or_else(|_| "claude-opus-5-5".into()),
            base_url: String::new(),
        },
        "openai" => Provider::OpenAi {
            api_key: env("OPENAI_API_KEY"),
            model: env("MODEL"),
            base_url: std::env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".into()),
        },
        _ => Provider::ClaudeCode {
            model: env("MODEL"),
        },
    };
    let request = Request {
        system: "You are a terse assistant.".into(),
        messages: vec![Message {
            role: Role::User,
            content: prompt,
        }],
        effort: "low".into(),
    };
    let mut pieces = 0;
    let result = stream(&provider, &request, &mut |t| {
        pieces += 1;
        print!("{t}");
        let _ = std::io::stdout().flush();
    })
    .await;
    println!();
    match result {
        Ok(answer) => eprintln!("[ok: {pieces} pieces, {} chars]", answer.len()),
        Err(e) => {
            eprintln!("[error: {e}]");
            std::process::exit(1);
        }
    }
}
