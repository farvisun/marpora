//! Server-sent events, as the Anthropic and OpenAI streaming APIs send them.

/// One event: its `event:` name (empty when none) and its `data:` lines joined.
#[derive(Debug, PartialEq, Eq)]
pub struct Event {
    pub event: String,
    pub data: String,
}

/// Splits a byte stream into events; bytes may arrive cut anywhere.
#[derive(Default)]
pub struct Parser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl Parser {
    /// The events `chunk` completes.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Event> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() || !self.event.is_empty() {
                    out.push(Event {
                        event: std::mem::take(&mut self.event),
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => self.event = value.to_owned(),
                "data" => self.data.push(value.to_owned()),
                _ => {}
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_across_chunk_boundaries() {
        let mut p = Parser::default();
        assert!(p.feed(b"event: message_start\ndata: {\"a\"").is_empty());
        let got = p.feed(b":1}\n\n: comment\ndata: x\r\ndata: y\r\n\r\n");
        assert_eq!(
            got,
            vec![
                Event {
                    event: "message_start".into(),
                    data: "{\"a\":1}".into()
                },
                Event {
                    event: String::new(),
                    data: "x\ny".into()
                },
            ]
        );
    }
}
