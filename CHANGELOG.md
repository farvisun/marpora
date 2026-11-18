# Changelog

All notable changes to Marpora are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Right-to-left text: paragraphs, headings, list items, quotes and tables in Persian, Arabic or Hebrew show right to left, decided by their first letter or by most of their letters. Paragraph › Text Direction (⌥⇧⌘D toggles) sets a block by hand; the choice is remembered per file and never written to it.
- Preferences › Appearance › Right-to-Left Text: the installed font Persian letters show in (AzarMehr by default) and its size. Latin text keeps the theme's font.

## [1.0.3] - 2026-11-03

### Fixed

- Opening a file from Finder when Marpora isn't running no longer crashes the app.

## [1.0.2] - 2026-10-30

### Added

- Install with Homebrew: `brew install --cask farvisun/tap/marpora`. The release workflow keeps the cask current.
- This changelog, a security policy and issue templates.

### Changed

- Dependabot keeps the Rust crates, the web dependencies and the GitHub Actions up to date.

## [1.0.1] - 2026-10-29

### Added

- A new folded-M app icon, favicon and site logo.
- The landing page at https://farvisun.github.io/marpora/.

## [1.0.0] - 2026-10-29

### Added

- The first public release: a Markdown editor with Marp slide preview, a presenter view, and export to slides and PowerPoint, with themes from a folder.
- AI: ask about the selection, chat about the document or the files in the folder, custom prompts from a prompts folder, and agent edits that ask before they are applied.
- Updates from GitHub releases, installed from inside the app.

[Unreleased]: https://github.com/farvisun/marpora/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/farvisun/marpora/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/farvisun/marpora/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/farvisun/marpora/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/farvisun/marpora/releases/tag/v1.0.0
