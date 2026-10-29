# Benchmarks

How fast Marpora opens, types in and saves large documents, measured against the targets
in the plan. Both benchmarks build their documents by repeating
[fixtures/docs/features.md](../fixtures/docs/features.md), which has every kind of block
(math, diagrams, code fences, tables, footnotes, HTML). Each repeat's headings are
renamed `Part n: …`. Only the first repeat keeps its `[TOC]`: a table of contents in every
repeat lists every heading hundreds of times over, which no real document does.

## Running them

```sh
# Rust: parsing, the block index, patches, diffs (release build).
cargo run --release -q -p marpora-core --example bench

# The editor in Playwright WebKit (the engine of the app's WKWebView), on a production
# build served by `vite preview`. The in-memory backend stands in for the app's Rust.
cd web
pnpm build
pnpm exec vite preview --port 4173 &
NO_PROXY=localhost node test/bench.mjs
```

The web benchmark takes several minutes, nearly all of it in the 5 MB case.

## Results

Measured on 2026-10-29 on an Apple Silicon Mac. The web numbers are from headless
WebKit, which paints in software; the app's GPU-composited window may differ.

| Rust (release, median of 7) | Time |
|---|---|
| Parse to ProseMirror JSON, 20k lines | 9.36 ms |
| Serialize the whole document, 20k lines | 5.52 ms |
| Open (block index), 20k lines | 8.98 ms |
| Parse to ProseMirror JSON, 5 MB | 156.62 ms |
| Serialize the whole document, 5 MB | 90.37 ms |
| Open (block index), 5 MB | 157.15 ms |
| Apply a keystroke (one block), 20k lines | 0.2 µs |
| Text for saving, 20k lines | 44.9 µs |
| Outside edit (diff to blocks), 20k lines | 9.01 ms |

| Editor (WebKit, production build) | Time |
|---|---|
| Startup to an editable document (median of 7) | 60 ms |
| Open, 20k lines (316 KB) | 536 ms |
| Keystroke to frame, 20k lines: p50 / p99 | 31 ms / 247 ms |
| Open, 5 MB | 54.4 s |
| Keystroke to frame, 5 MB: p50 / p99 | 2.9 s / 16.8 s |

"Keystroke to frame" runs from `keydown` until a task after the next animation frame, so it
includes ProseMirror's update, style, layout and paint.

## Against the targets

| Target | Result |
|---|---|
| Cold start under 300 ms | The editor is ready 60 ms after the page loads. The app's cold start (process, window, WebView) is not measured here; time it by hand from launching `Marpora.app` to the first paint. |
| Keystroke to paint p99 under 16 ms, 20k lines | **Missed:** p50 31 ms, p99 247 ms. In a Chromium profile the slowest keystrokes were the first formulas rendered after the jump into the document, which measure the page once. |
| 5 MB opens in under 1 s | **Missed** in the editor (54 s). The Rust side takes 157 ms, so the time is in building and laying out about 700,000 DOM nodes. |
| Idle memory under 120 MB | Not measured; check the app's processes (including its WebContent process) in Activity Monitor. |

## What changed after the first run

The first run, with a `[TOC]` in every repeat, gave p50 84 ms and p99 5.8 s per keystroke
on 20k lines, and the 5 MB case did not finish. Profiling found:

- **Formula metrics:** MathJax measured the page for every inline formula, a full layout
  each time. It now measures once for inline math and once for display math (`web/src/math.ts`).
- **Tables of contents:** every `[TOC]` scanned the document's headings on every change.
  One scan is now shared by all of them (`web/src/editor/nodeviews.ts`).
- **Decorations:** the inline HTML decorations and the task list checkboxes were rebuilt
  for the whole document on every keystroke. Now only the blocks an edit touched are
  rebuilt (`web/src/editor/blockwise.ts`).
- **Word count:** the status bar re-counted the whole text on each refresh. Counts are now
  cached per block (`countDoc` in `web/src/chrome/store.ts`).

On the same document these took a keystroke from p50 84 ms to 42 ms.

**Tried and dropped:** `content-visibility: auto` on top-level blocks made typing slower
in WebKit (p50 311 ms). It also changes layout (margins stop collapsing through
blockquotes and lists) and clips popovers.

## What is left

- **Very large files.** Above a few megabytes the editor builds too much DOM. The plan's
  fallback is to open such files in source mode, whose CodeMirror editor draws only the
  lines on screen, and to warn before switching to the rich view.
- **Native typing cost.** About 9 ms of each keystroke on 20k lines is WebKit's own
  editing work, between `keypress` and `beforeinput`, before Marpora sees the input.
