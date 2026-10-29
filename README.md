# Marpora

A Markdown editor for macOS that shows the document as it will look while you write it,
in the manner of Typora, with AI built in and Marp slide decks.

- **Live preview.** The Markdown shows only around the cursor. Tables, math (MathJax),
  diagrams (Mermaid, flowchart, sequence), code fences, footnotes, task lists, front
  matter and raw HTML all render in place. Source mode (⌘/), focus mode (F8) and
  typewriter mode (F9) are one key away.
- **Typora themes.** The editor uses Typora's markup and class names, so Typora themes
  load unchanged. Put their CSS in the themes folder (Help › Custom Themes).
- **Files.** A sidebar with the folder's files, the outline and search across files.
  Autosave, draft recovery, and edits on disk merged in as they happen.
- **Export.** PDF, HTML, image, and through Pandoc Word, OpenOffice, EPUB, LaTeX and more.
- **AI.** Ask AI (⇧⌘J) rewrites the selection or writes at the cursor. The chat (⌥⌘J)
  answers about the document, or about every file in the folder. Custom prompts live
  in a folder of Markdown files. Works with the Anthropic API, any OpenAI-compatible API,
  or the Claude Code and Codex CLIs you are signed in to.
- **Agents.** Claude Code, Codex and other MCP clients can read and edit the open
  documents. Their edits show at once and undo with ⌘Z, or wait for your review.
- **Slides.** A document with `marp: true` is a Marp deck: a live slide preview, theme
  picker, a presenter view with notes and timer, and export to PDF, HTML and PowerPoint.

Help › Quick Start in the app covers each feature
([src-tauri/help/Quick Start.md](src-tauri/help/Quick%20Start.md)).

## How it is built

A Tauri 2 app. The editor is ProseMirror in the system WebView, with SolidJS for the
window's chrome. The Markdown parser and serializer are one Rust crate, compiled
natively and to WebAssembly. Saving writes untouched blocks back byte for byte, so
diffs stay small.

| Path | What |
|---|---|
| `crates/md` | Markdown ⇄ ProseMirror JSON (comrak), native and WASM |
| `crates/core` | Documents as blocks, patches, diffs of outside edits |
| `crates/llm` | Model providers, streaming, the folder tools |
| `src-tauri` | The app: windows, menus, files, export, AI, the MCP server |
| `web` | The editor and the window's chrome |
| `fixtures/docs` | Documents with every kind of block, for tests |
| `docs` | Notes such as [benchmarks](docs/benchmarks.md) |

## Building

You need Rust (stable, with the `wasm32-unknown-unknown` target), `wasm-bindgen-cli`
at the version in `Cargo.lock`, Node 24 and pnpm 10, and Xcode's command line tools.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
cd web && pnpm install
pnpm tauri dev      # run the app
pnpm tauri build    # Marpora.app and a DMG in target/release/bundle
```

## Tests

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd web
pnpm typecheck
pnpm test                         # unit tests (Vitest)
pnpm exec vite & pnpm test:e2e    # the editor in Playwright WebKit, with an in-memory backend
```

[docs/benchmarks.md](docs/benchmarks.md) covers the speed measurements.

## License

[MIT](LICENSE). MathJax, Mermaid, Marp Core, CodeMirror and the other bundled libraries
keep their own licences.
