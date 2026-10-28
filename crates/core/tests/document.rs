use marpora_core::{Document, Patch, PatchError};

const SRC: &str = "---\ntitle: x\n---\n\n# Title\n\nFirst  paragraph   with odd   spacing.\n\n\n\n* star list\n* item\n\nLast.\n";

fn patch(doc: &Document, start: usize, delete: usize, insert: &[&str]) -> Patch {
    Patch {
        base_version: doc.version(),
        start,
        delete,
        insert: insert.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn unchanged_document_is_byte_identical() {
    for src in [
        SRC,
        "",
        "\n\n",
        "no newline",
        "a\r\n\r\nb\r\n",
        "  indented para\n",
    ] {
        assert_eq!(Document::from_markdown(src).text(), src);
    }
}

#[test]
fn editing_one_block_only_changes_its_bytes() {
    let mut doc = Document::from_markdown(SRC);
    assert_eq!(
        doc.blocks()[2].text,
        "First  paragraph   with odd   spacing."
    );
    doc.apply(&patch(&doc, 1, 1, &["# New title"])).unwrap();
    assert_eq!(doc.text(), SRC.replace("# Title", "# New title"));
    assert!(doc.is_dirty());
}

#[test]
fn inserting_and_deleting_blocks_keeps_neighbours() {
    let mut doc = Document::from_markdown(SRC);
    doc.apply(&patch(&doc, 2, 0, &["Inserted."])).unwrap();
    assert!(
        doc.text()
            .contains("# Title\n\nInserted.\n\nFirst  paragraph")
    );
    doc.apply(&patch(&doc, 2, 1, &[])).unwrap();
    assert_eq!(doc.text(), SRC);
}

#[test]
fn appending_moves_the_file_tail() {
    let mut doc = Document::from_markdown("a\n");
    doc.apply(&patch(&doc, 1, 0, &["b", "c"])).unwrap();
    assert_eq!(doc.text(), "a\n\nb\n\nc\n");
    doc.apply(&patch(&doc, 1, 2, &[])).unwrap();
    assert_eq!(doc.text(), "a\n");
}

#[test]
fn empty_document_has_one_block_to_edit() {
    let mut doc = Document::from_markdown("");
    assert_eq!(doc.blocks().len(), 1);
    doc.apply(&patch(&doc, 0, 1, &["Hello"])).unwrap();
    assert_eq!(doc.text(), "Hello");
}

#[test]
fn single_newline_separators_get_a_blank_line_when_blocks_could_merge() {
    let mut doc = Document::from_markdown("# H\ntext\n");
    // Heading stays a heading: the original single newline is fine.
    doc.apply(&patch(&doc, 0, 1, &["## H"])).unwrap();
    assert_eq!(doc.text(), "## H\ntext\n");
    // Heading becomes a paragraph: it would merge with `text`.
    doc.apply(&patch(&doc, 0, 1, &["H"])).unwrap();
    assert_eq!(doc.text(), "H\n\ntext\n");
}

#[test]
fn crlf_documents_stay_crlf() {
    let mut doc = Document::from_markdown("a\r\n\r\nb\r\n");
    doc.apply(&patch(&doc, 1, 1, &["line one\nline two"]))
        .unwrap();
    assert_eq!(doc.text(), "a\r\n\r\nline one\r\nline two\r\n");
}

#[test]
fn stale_patches_are_rejected() {
    let mut doc = Document::from_markdown(SRC);
    let p = patch(&doc, 0, 0, &["x"]);
    doc.apply(&p).unwrap();
    assert_eq!(
        doc.apply(&p),
        Err(PatchError::Stale {
            base: 0,
            current: 1
        })
    );
}

#[test]
fn external_change_becomes_minimal_remote_patch() {
    let mut doc = Document::from_markdown(SRC);
    let changed = SRC.replace("Last.", "Last, edited by an agent.");
    let remote = doc.replace_text(&changed, &Default::default()).unwrap();
    assert_eq!(
        (remote.start, remote.delete, remote.insert.len()),
        (4, 1, 1)
    );
    assert_eq!(remote.insert[0].kind, "paragraph");
    assert_eq!(doc.text(), changed);
    assert!(doc.replace_text(&changed, &Default::default()).is_none());
}
