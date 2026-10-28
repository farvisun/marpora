use marpora_md::pm::Node;
use marpora_md::{Flavor, Parsed, serialize_block, serialize_doc};
use proptest::prelude::*;

fn parse(src: &str) -> Parsed {
    marpora_md::parse(src, &Flavor::all())
}

const FIXTURES: &[&str] = &[include_str!("../../../fixtures/docs/features.md")];

fn assert_spans(src: &str) {
    let parsed = parse(src);
    assert_eq!(parsed.doc.content.len(), parsed.blocks.len());
    let mut cursor = 0;
    for span in &parsed.blocks {
        assert!(span.start >= cursor, "overlapping span {span:?} in {src:?}");
        assert!(
            src[cursor..span.start].trim().is_empty(),
            "non-whitespace gap {:?} in {src:?}",
            &src[cursor..span.start]
        );
        cursor = span.end;
    }
    assert!(
        src[cursor..].trim().is_empty(),
        "non-whitespace tail in {src:?}"
    );
}

/// Drop attrs that only steer serialization style (autolink vs `<url>` vs `[text](url)`).
fn normalize(mut node: Node) -> Node {
    for mark in &mut node.marks {
        mark.attrs.remove("kind");
        mark.attrs.remove("ref");
        mark.attrs.remove("markup");
    }
    node.content = node.content.into_iter().map(normalize).collect();
    node
}

/// Drop delimiter-run marks and merge text. CommonMark's flanking rules make some
/// placements of these marks next to punctuation unrepresentable, so fuzzing only
/// requires text and structure to survive; exact equality is asserted elsewhere.
fn strip_delimiter_marks(mut node: Node) -> Node {
    const DELIMITER_MARKS: [&str; 6] = ["em", "strong", "strike", "highlight", "sup", "sub"];
    node.marks
        .retain(|m| !DELIMITER_MARKS.contains(&m.kind.as_str()));
    let mut content: Vec<Node> = Vec::new();
    for child in node.content.into_iter().map(strip_delimiter_marks) {
        if let Some(last) = content.last_mut()
            && last.is_text()
            && child.is_text()
            && last.marks == child.marks
        {
            last.text
                .get_or_insert_default()
                .push_str(child.text.as_deref().unwrap_or(""));
            continue;
        }
        content.push(child);
    }
    node.content = content;
    node
}

fn text_round_trip(src: &str, flavor: &Flavor) -> Result<(), String> {
    let first = marpora_md::parse(src, flavor).doc;
    let md = serialize_doc(&first);
    let second = marpora_md::parse(&md, flavor).doc;
    let (a, b) = (
        strip_delimiter_marks(normalize(first)),
        strip_delimiter_marks(normalize(second)),
    );
    if a == b {
        return Ok(());
    }
    Err(format!(
        "\n--- source ---\n{src:?}\n--- serialized ---\n{md:?}\n--- before ---\n{}\n--- after ---\n{}",
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap(),
    ))
}

/// Serializing a parsed document and parsing it again yields the same document.
fn round_trip(src: &str) -> Result<(), String> {
    let first = parse(src).doc;
    let md = serialize_doc(&first);
    let (first, second) = (normalize(first), normalize(parse(&md).doc));
    if first == second {
        return Ok(());
    }
    Err(format!(
        "\n--- source ---\n{src:?}\n--- serialized ---\n{md:?}\n--- before ---\n{}\n--- after ---\n{}",
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap(),
    ))
}

fn assert_round_trip(src: &str) {
    if let Err(e) = round_trip(src) {
        panic!("{e}");
    }
}

#[test]
fn fixtures_have_exact_spans() {
    for src in FIXTURES {
        assert_spans(src);
    }
}

#[test]
fn fixtures_round_trip() {
    for src in FIXTURES {
        assert_round_trip(src);
    }
}

#[test]
fn every_block_reserializes_to_itself_when_canonical() {
    let src = "# Title\n\nSome *text* and **more**.\n\n- a\n- b\n\n```js\nx\n```\n";
    let parsed = parse(src);
    for (node, span) in parsed.doc.content.iter().zip(&parsed.blocks) {
        assert_eq!(serialize_block(node), &src[span.clone()]);
    }
}

#[test]
fn empty_and_blank_documents_have_one_paragraph() {
    for src in ["", "\n", "   \n\n"] {
        let parsed = parse(src);
        assert_eq!(parsed.doc.content.len(), 1);
        assert_eq!(parsed.doc.content[0].kind, "paragraph");
        assert_spans(src);
    }
}

#[test]
fn crlf_spans_exclude_carriage_returns() {
    let src = "# A\r\n\r\npara\r\n";
    let parsed = parse(src);
    assert_eq!(&src[parsed.blocks[0].clone()], "# A");
    assert_eq!(&src[parsed.blocks[1].clone()], "para");
}

#[test]
fn edge_cases_round_trip() {
    for src in [
        "**foo**bar",
        "__foo__bar",
        "a *b* c",
        "* not a list item when escaped",
        "1986\\. A great year",
        "\\# not a heading",
        "x <span>html</span> y",
        "price: $5 or $10",
        "a\\\nb",
        "[a](<url with space>)",
        "![alt](a(b).png)",
        "- [ ] \n- [x] done",
        "text ~~gone~~ and H~2~O",
        "`` a`b ``",
        "> quote\nlazy",
        "Term\n===",
        "| a | b |\n|---|---|\n| 1 | 2 |",
        "<https://a.b> and https://c.d",
        "a  \nb",
        "[x][y]\n\n[y]: /url",
        "trailing #",
        "&amp; and &copy and AT&T",
        "see http://a.co, and *https://b.co* or **<https://c.co>**.",
        "mail me@example.com or <me@example.com>",
        "[http://a.co](http://a.co)",
    ] {
        assert_spans(src);
        assert_round_trip(src);
    }
}

fn md_soup() -> impl Strategy<Value = String> {
    let token = prop_oneof![
        Just("*"),
        Just("**"),
        Just("_"),
        Just("__"),
        Just("`"),
        Just("~"),
        Just("~~"),
        Just("^"),
        Just("=="),
        Just("$"),
        Just("["),
        Just("]"),
        Just("("),
        Just(")"),
        Just("!"),
        Just("<"),
        Just(">"),
        Just("#"),
        Just("-"),
        Just("+"),
        Just("1."),
        Just("\\"),
        Just("&"),
        Just("|"),
        Just(" "),
        Just(" "),
        Just("\n"),
        Just("\n\n"),
        Just("word"),
        Just("x"),
        Just("42"),
        Just(":"),
        Just("."),
    ];
    proptest::collection::vec(token, 0..24).prop_map(|t| t.concat())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2000, ..ProptestConfig::default() })]

    #[test]
    fn spans_are_exact(src in md_soup()) {
        assert_spans(&src);
    }

    #[test]
    fn soup_round_trips(src in md_soup()) {
        text_round_trip(&src, &Flavor::all()).map_err(TestCaseError::fail)?;
    }

    #[test]
    fn soup_round_trips_with_typora_defaults(src in md_soup()) {
        text_round_trip(&src, &Flavor::default()).map_err(TestCaseError::fail)?;
    }
}

#[test]
fn typora_defaults_leave_optional_syntax_as_text() {
    let src = "a $x$ b ==hi== H~2~O x^2^";
    let doc = marpora_md::parse(src, &Flavor::default()).doc;
    let para = &doc.content[0];
    assert_eq!(para.content.len(), 1, "{para:?}");
    assert_eq!(para.content[0].text.as_deref(), Some(src));
    assert!(para.content[0].marks.is_empty());
}

#[test]
fn math_blocks_parse_in_every_flavor() {
    for flavor in [Flavor::default(), Flavor::all()] {
        let doc = marpora_md::parse("$$\nx^2\n$$", &flavor).doc;
        assert_eq!(doc.content[0].kind, "math_block");
    }
}

#[test]
fn flavor_json_defaults_missing_fields() {
    let f: Flavor = serde_json::from_str(r#"{"inlineMath":true}"#).unwrap();
    assert_eq!(f, Flavor { inline_math: true, ..Flavor::default() });
}

#[test]
fn whitespace_stays_inside_links() {
    let doc = parse("&[ ](u) and [ x ](u) or *x* ").doc;
    assert_eq!(serialize_doc(&doc), "&[ ](u) and [ x ](u) or *x*\n");
}
