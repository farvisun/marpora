//! `cargo run --example rt -- 'markdown'`: show the PM JSON and round trip of a snippet.
fn main() {
    let src = std::env::args().nth(1).expect("markdown");
    let src = src.replace("\\n", "\n");
    let first = marpora_md::parse(&src, &marpora_md::Flavor::all()).doc;
    let md = marpora_md::serialize_doc(&first);
    let second = marpora_md::parse(&md, &marpora_md::Flavor::all()).doc;
    println!("src: {src:?}\nout: {md:?}\nsame: {}", first == second);
    println!("before: {}", serde_json::to_string(&first).unwrap());
    if first != second {
        println!("after:  {}", serde_json::to_string(&second).unwrap());
    }
}
