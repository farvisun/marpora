<p align="center"><img src="site/assets/icon.png" alt="" width="128" height="128"></p>

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

## Install

Download [Marpora.dmg](https://github.com/farvisun/marpora/releases/latest/download/Marpora.dmg)
(macOS 12 or later, Apple Silicon and Intel), open it and drag Marpora to Applications.

Marpora is ad-hoc signed, not notarized, so macOS blocks its first launch. Open
**System Settings › Privacy & Security** and click **Open Anyway**, or run:

```sh
xattr -dr com.apple.quarantine /Applications/Marpora.app
```

Updates install from inside the app: it checks at launch, and on
**Marpora › Check for Updates…**.

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

## Releasing

Bump `version` in `Cargo.toml` and `web/package.json`, commit, then push a tag:

```sh
git tag v1.0.1 && git push origin v1.0.1
```

[.github/workflows/release.yml](.github/workflows/release.yml) builds a universal app,
signs the update archive with the `TAURI_SIGNING_PRIVATE_KEY` secret, and publishes the
release with `latest.json`, the feed the app's updater reads. The landing page in
`site/` deploys to GitHub Pages on every push that changes it.

## License

[MIT](LICENSE). MathJax, Mermaid, Marp Core, CodeMirror and the other bundled libraries
keep their own licences.
