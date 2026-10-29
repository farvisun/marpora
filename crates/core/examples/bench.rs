//! `cargo run --release -p marpora-core --example bench`: time the Rust side of opening,
//! typing in and saving large documents (see docs/benchmarks.md). The documents repeat
//! fixtures/docs/features.md, which has every kind of block.

use std::time::{Duration, Instant};

use marpora_core::{Document, Patch};
use marpora_md::Flavor;

const FIXTURE: &str = include_str!("../../../fixtures/docs/features.md");

/// The fixture repeated while `fits` holds, with one `[TOC]` (as web/test/bench.mjs).
fn document(fits: impl Fn(&str) -> bool) -> String {
    let mut out = String::new();
    let mut i = 0;
    while fits(&out) {
        i += 1;
        let part = match i {
            1 => FIXTURE.to_owned(),
            _ => FIXTURE.replacen("[TOC]\n", "", 1),
        };
        out.push_str(&part.replace("# ", &format!("# Part {i}: ")));
        out.push('\n');
    }
    out
}

/// The median of `runs` timings of `f`.
fn median(runs: usize, mut f: impl FnMut()) -> Duration {
    let mut times: Vec<Duration> = (0..runs)
        .map(|_| {
            let start = Instant::now();
            f();
            start.elapsed()
        })
        .collect();
    times.sort();
    times[runs / 2]
}

fn ms(d: Duration) -> String {
    match d.as_secs_f64() * 1000.0 {
        t if t < 0.1 => format!("{:.1} µs", t * 1000.0),
        t => format!("{t:.2} ms"),
    }
}

fn row(what: &str, d: Duration) {
    println!("| {what} | {} |", ms(d));
}

fn main() {
    let flavor = Flavor::all();
    let lines = document(|s| s.lines().count() < 20_000);
    let big = document(|s| s.len() < 5 << 20);
    println!(
        "Documents: {} lines ({} KB), and {} lines ({:.1} MB).\n",
        lines.lines().count(),
        lines.len() / 1024,
        big.lines().count(),
        big.len() as f64 / (1 << 20) as f64
    );
    println!("| Rust (release, median of 7) | Time |\n|---|---|");

    for (name, src) in [("20k lines", &lines), ("5 MB", &big)] {
        row(
            &format!("Parse to ProseMirror JSON, {name}"),
            median(7, || {
                std::hint::black_box(marpora_md::parse(src, &flavor));
            }),
        );
        let doc = marpora_md::parse(src, &flavor).doc;
        row(
            &format!("Serialize the whole document, {name}"),
            median(7, || {
                std::hint::black_box(marpora_md::serialize_doc(&doc));
            }),
        );
        row(
            &format!("Open (block index), {name}"),
            median(7, || {
                std::hint::black_box(Document::from_markdown(src));
            }),
        );
    }

    // Typing: the editor sends the one block that changed.
    let mut doc = Document::from_markdown(&lines);
    let middle = doc.blocks().len() / 2;
    let typed = median(101, || {
        let text = format!("{}x", doc.blocks()[middle].text);
        let patch = Patch {
            base_version: doc.version(),
            start: middle,
            delete: 1,
            insert: vec![text],
        };
        doc.apply(&patch).unwrap();
    });
    row("Apply a keystroke (one block), 20k lines", typed);
    row(
        "Text for saving, 20k lines",
        median(7, || {
            std::hint::black_box(doc.text());
        }),
    );

    // An agent's or the disk's version: diffed to the blocks that changed.
    let mut doc = Document::from_markdown(&lines);
    let edited = doc.text().replacen("Part 300:", "Part three hundred:", 1);
    let flip = [doc.text(), edited];
    let mut i = 0;
    row(
        "Outside edit (diff to blocks), 20k lines",
        median(7, || {
            i += 1;
            std::hint::black_box(doc.replace_text(&flip[i % 2], &flavor));
        }),
    );
}
