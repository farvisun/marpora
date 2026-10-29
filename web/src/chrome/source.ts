// Source code mode (⌘/): the raw Markdown in a CodeMirror 5 editor, as in Typora.
//
// Entering flushes the editor and loads the core's text; edits go back to the core as
// whole-text replacements; leaving reloads the WYSIWYG editor from the core. The cursor
// carries over at block granularity, using the block spans the parser reports.

import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { type CodeMirrorEditor, codemirror, loadAddon, loadMode } from "../cm";
import type { DocSync } from "../editor/sync";
import type { Backend } from "../ipc";
import { parseMarkdown } from "../md";

const utf8 = new TextEncoder();

/** Byte offset of the start of each top-level block. */
function blockStarts(text: string): number[] {
  return parseMarkdown(text).blocks.map(([start]) => start);
}

/** Zero-based line of a UTF-8 byte offset. */
function lineOfByte(text: string, byte: number): number {
  const bytes = utf8.encode(text);
  let line = 0;
  for (let i = 0; i < byte && i < bytes.length; i++) if (bytes[i] === 10) line++;
  return line;
}

/** UTF-8 byte offset of the start of a zero-based line. */
function byteOfLine(text: string, line: number): number {
  let index = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf("\n", index);
    if (nl < 0) break;
    index = nl + 1;
  }
  return utf8.encode(text.slice(0, index)).length;
}

/** Index of the top-level block holding zero-based `line` of `text`. */
export function blockOfLine(text: string, line: number): number {
  const byte = byteOfLine(text, line);
  const starts = blockStarts(text);
  let block = 0;
  while (block + 1 < starts.length && starts[block + 1] <= byte) block++;
  return block;
}

export class SourceMode {
  private editor: CodeMirrorEditor | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Text the core has, to skip sending unchanged text. */
  private sent = "";
  active = false;
  /** View › Readonly Mode. */
  private readonly = false;

  setReadonly(on: boolean) {
    this.readonly = on;
    this.editor?.setOption("readOnly", on);
  }

  /** The source editor, once source mode has been entered. */
  get codeMirror(): CodeMirrorEditor | null {
    return this.editor;
  }

  constructor(
    private backend: Backend,
    private docId: number,
    private sync: DocSync,
    private view: () => EditorView,
    private host: () => HTMLElement,
  ) {}

  async toggle(): Promise<boolean> {
    if (this.active) await this.exit();
    else await this.enter();
    return this.active;
  }

  async enter(): Promise<void> {
    if (this.active) return;
    const view = this.view();
    const block = view.state.doc.resolve(view.state.selection.head).index(0);
    await this.sync.flush();
    const { text } = await this.backend.documentText(this.docId);
    const editor = await this.ensureEditor(text);
    editor.setOption("readOnly", this.readonly);
    this.sent = text;
    editor.setValue(text);
    editor.clearHistory();
    this.active = true;
    document.body.classList.add("typora-sourceview-on");
    editor.refresh();
    const start = blockStarts(text)[block] ?? 0;
    const line = lineOfByte(text, start);
    editor.setCursor(line, 0);
    editor.scrollIntoView({ line, ch: 0 }, 100);
    editor.focus();
  }

  async exit(): Promise<void> {
    if (!this.active || !this.editor) return;
    await this.flush();
    const text = this.editor.getValue();
    const block = blockOfLine(text, this.editor.getCursor().line);

    this.active = false;
    document.body.classList.remove("typora-sourceview-on");
    await this.sync.resync();
    const view = this.view();
    let pos = 0;
    for (let i = 0; i < block && i < view.state.doc.childCount; i++) pos += view.state.doc.child(i).nodeSize;
    const sel = TextSelection.near(view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size)));
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
    view.focus();
  }

  /** Show the core's text after a change made elsewhere (the file changed on disk). */
  async reload(): Promise<void> {
    const editor = this.editor;
    if (!this.active || !editor) return;
    const { text } = await this.backend.documentText(this.docId);
    if (text === editor.getValue()) return;
    const cursor = editor.getCursor();
    this.sent = text;
    editor.setValue(text);
    editor.setCursor(cursor.line, cursor.ch);
  }

  /** Menu commands that make sense on plain text. */
  command(id: string) {
    const editor = this.editor;
    if (!editor) return;
    const cursor = editor.getCursor();
    const line = (n: number) => editor.getLine(n);
    const swap = (other: number) => {
      if (other < 0 || other >= editor.lineCount()) return;
      const [a, b] = [Math.min(cursor.line, other), Math.max(cursor.line, other)];
      editor.replaceRange(`${line(b)}\n${line(a)}`, { line: a, ch: 0 }, { line: b, ch: line(b).length });
      editor.setCursor(other, cursor.ch);
    };
    const recase = (change: (t: string) => string) => editor.replaceSelection(change(editor.getSelection()), "around");
    // The Edit menu's items, as CodeMirror does them.
    const actions: Record<string, () => void> = {
      undo: () => editor.undo(),
      redo: () => editor.redo(),
      "jump-top": () => editor.execCommand("goDocStart"),
      "jump-bottom": () => editor.execCommand("goDocEnd"),
      "jump-selection": () => editor.scrollIntoView(null),
      "select-word": () => {
        const word = editor.findWordAt(cursor);
        editor.setSelection(word.anchor, word.head);
      },
      "select-line": () => editor.setSelection({ line: cursor.line, ch: 0 }, { line: cursor.line, ch: line(cursor.line).length }),
      "delete-line": () => editor.execCommand("deleteLine"),
      "delete-word": () => {
        const word = editor.findWordAt(cursor);
        editor.replaceRange("", word.anchor, word.head);
      },
      "move-row-up": () => swap(cursor.line - 1),
      "move-row-down": () => swap(cursor.line + 1),
      "upper-case": () => recase((t) => t.toUpperCase()),
      "lower-case": () => recase((t) => t.toLowerCase()),
    };
    actions[id]?.();
    editor.focus();
  }

  /** Send pending source edits to the core (before saving or closing). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.active || !this.editor) return;
    const text = this.editor.getValue();
    if (text === this.sent) return;
    this.sent = text;
    await this.backend.setText(this.docId, text);
  }

  private async ensureEditor(text: string): Promise<CodeMirrorEditor> {
    if (this.editor) return this.editor;
    const cm = await codemirror();
    await Promise.all([loadMode({ name: "Markdown", mode: "markdown" }), loadAddon("selection/active-line")]);
    const host = this.host();
    this.editor = cm(host, {
      value: text,
      mode: { name: "markdown", highlightFormatting: true, xml: false },
      theme: "typora-default",
      lineWrapping: true,
      styleActiveLine: true,
      indentUnit: 4,
      // Keep the file's line endings when the text goes back to the core.
      lineSeparator: text.includes("\r\n") ? "\r\n" : null,
      extraKeys: { Tab: "indentMore", "Shift-Tab": "indentLess" },
    });
    this.editor.on("changes", () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), 300);
    });
    return this.editor;
  }
}
