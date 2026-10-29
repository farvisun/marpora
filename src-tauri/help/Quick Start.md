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

## AI

Choose a model in **AI › AI Settings…**: the Anthropic API or any OpenAI-compatible one (keys are kept in the macOS Keychain), or the Claude Code or Codex CLI you are already signed in to.

- **AI › Ask AI…** (⇧⌘J) opens a prompt under the selection. Type what you want, or pick a preset such as *Improve Writing* or *Make Shorter*. With no selection it writes at the cursor. The answer streams into a preview: ↵ puts it in, ⌥↵ puts it below, Esc throws it away. One ⌘Z undoes it.
- **AI › AI Chat** (⌥⌘J) opens a panel for questions about the document. Your selection goes with each question, and an answer can be inserted at the cursor or put in place of the selection.
- Turn on **Folder** in the chat to ask about the other files in the sidebar's folder too. The model can then search, list and read the Markdown files in that folder (nothing outside it), and each step it takes shows in the chat.
- **AI › Custom Prompts** runs prompts of your own. Each is a `.md` file in the prompts folder (**AI › Custom Prompts › Open Prompts Folder**): the file name is the prompt's name and its text is the instruction. They also show in Ask AI's list.

## Agents

Coding agents such as Claude Code and Codex can read and edit the documents open in Marpora. Their edits show at once, and ⌘Z takes them back. Connect one through MCP:

```sh
claude mcp add marpora -- /Applications/Marpora.app/Contents/MacOS/marpora mcp
codex mcp add marpora -- /Applications/Marpora.app/Contents/MacOS/marpora mcp
```

The agent can then list, read and edit open documents, see what you have selected, open files and save them.

To review agent edits before they land, set **Preferences › AI › Agent edits** to *Ask me first*. Each edit then shows the lines it changes, with **Accept**, **Reject** and **Always Allow** for that agent. **Forget Always-Allowed Agents** asks again.

## Slides

A document with `marp: true` in its front matter is a [Marp](https://marp.app) slide deck: `---` separates the slides, and comments such as `<!-- _class: lead -->` set directives. HTML comments that are not directives are the speaker notes.

```markdown
---
marp: true
theme: gaia
---

# First slide

<!-- Notes for the first slide. -->

---

## Second slide
```

- **View › Slide Preview** (⌥⌘M) shows the slides beside the text and follows the cursor. Its theme menu sets the deck's `theme:`; to add themes, put Marp theme `.css` files in the folder its **Open Theme Folder** opens.
- **View › Present Slides** (⌥⌘↩) opens the slides full screen with a presenter view: the current and next slide, the notes and a timer. → or Space goes on, ← goes back, B blacks the screen, Esc ends.
- **File › Export › PDF** and **HTML** export a deck as its slides, one slide a page. **File › Export › PowerPoint (Slides)** makes a `.pptx` with one picture a slide and the notes as speaker notes.

## Themes

Pick a theme from the **Themes** menu. To add your own, put a `.css` file in the themes folder (**Help › Custom Themes**) and choose it from the menu. Typora themes work unchanged.

See **Help › Markdown Reference** for the full syntax.
