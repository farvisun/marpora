# Quick Start

Marpora is a Markdown editor that shows your document as it will look while you write it. The Markdown appears around the cursor only, so you see the formatting and can still edit the source.

## Writing

Type Markdown the way you normally would. A heading line starting with `#`, a list item starting with `-`, a quote starting with `>` or a fence starting with ```` ``` ```` each turn into the block as soon as you type the space or press Return.

Most formatting is also in the **Paragraph** and **Format** menus:

| Action          | Shortcut |
| --------------- | -------- |
| Heading 1 to 6  | ⌘1 to ⌘6 |
| Paragraph       | ⌘0       |
| Strong          | ⌘B       |
| Emphasis        | ⌘I       |
| Underline       | ⌘U       |
| Inline code     | ⌃\`      |
| Strike          | ⌃⇧\`     |
| Highlight       | ⇧⌘H      |
| Hyperlink       | ⌘K       |
| Insert image    | ⌃⌘I      |
| Quote           | ⌥⌘Q      |
| Ordered list    | ⌥⌘O      |
| Unordered list  | ⌥⌘U      |
| Task list       | ⌥⌘X      |
| Insert table    | ⌥⌘T      |
| Code fences     | ⌥⌘C      |
| Math block      | ⌥⌘B      |
| Inline math     | ⌃M       |

Right-click in the text for the same actions, plus the ones that fit what you clicked: table rows and columns, links, and code blocks.

## Files

- **File › Open…** (⌘O) opens a document; **File › Open Folder…** shows a folder in the sidebar.
- **File › Open Quickly…** (⇧⌘O) finds a file by name.
- **File › Save** (⌘S) saves the document. Turn on auto save in Preferences to save as you type.
- **File › Export** writes PDF, HTML and an image. With [Pandoc](https://pandoc.org) installed, it also writes Word, OpenOffice, RTF, Epub, LaTeX and more. **File › Import…** uses Pandoc too.

## Views

- **View › Source Code Mode** (⌘/) shows the plain Markdown.
- **View › Toggle Sidebar** (⇧⌘L) shows the files, the outline and the search across a folder.
- **View › Focus Mode** (F8) dims all but the current paragraph.
- **View › Typewriter Mode** (F9) keeps the current line in the middle of the window.
- Click the word count in the status bar for words, characters, lines and reading time.

## Agents

Coding agents such as Claude Code and Codex can read and edit the documents open in Marpora. Their edits show at once, and ⌘Z takes them back. Connect one through MCP:

```sh
claude mcp add marpora -- /Applications/Marpora.app/Contents/MacOS/marpora mcp
codex mcp add marpora -- /Applications/Marpora.app/Contents/MacOS/marpora mcp
```

The agent can then list, read and edit open documents, see what you have selected, open files and save them.

## Themes

Pick a theme from the **Themes** menu. To add your own, put a `.css` file in the themes folder (**Help › Custom Themes**) and choose it from the menu. Typora themes work unchanged.

See **Help › Markdown Reference** for the full syntax.
