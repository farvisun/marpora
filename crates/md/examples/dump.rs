//! `cargo run --example dump -- file.md`: print spans, PM JSON and the round trip.
fn main() {
    let path = std::env::args().nth(1).expect("path");
    let src = std::fs::read_to_string(path).unwrap();
    let parsed = marpora_md::parse(&src, &marpora_md::Flavor::all());
    for (node, span) in parsed.doc.content.iter().zip(&parsed.blocks) {
        println!("{:>14} {:?} {:?}", node.kind, span, &src[span.clone()]);
    }
    println!("{}", serde_json::to_string_pretty(&parsed.doc).unwrap());
    println!(
        "---- serialized ----\n{}",
        marpora_md::serialize_doc(&parsed.doc)
    );
}
