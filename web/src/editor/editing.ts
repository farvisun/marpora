// Edit menu commands as Typora has them: Selection (word, line, styled scope, block),
// Jump To, Move Row Up/Down, Delete Range, Transformations and the Copy As variants.

import { DOMSerializer, type Node as PMNode, type ResolvedPos } from "prosemirror-model";
import { type Command, type EditorState, NodeSelection, Selection, TextSelection } from "prosemirror-state";
import { sliceMarkdown } from "./clipboard";
import { schema } from "./schema";
import { moveRow, tableAt } from "./table";

type Range = { from: number; to: number };

/** Where copies go: the backend's pasteboard in the app (menu items are not user
 * gestures, which the webview's clipboard API needs), the web clipboard otherwise. */
let clipboardWriter = (text: string, html?: string): Promise<void> =>
  html
    ? navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ])
    : navigator.clipboard.writeText(text);

export function setClipboardWriter(write: (text: string, html?: string) => Promise<void>) {
  clipboardWriter = write;
}

export function writeClipboard(text: string, html?: string) {
  void clipboardWriter(text, html).catch((e) => console.error(e));
}

/** The text of `$pos`'s textblock with one character per position (atoms as U+FFFC,
 * breaks as newlines), so string offsets are position offsets. */
function blockText($pos: ResolvedPos): string {
  const block = $pos.parent;
  return block.textBetween(0, block.content.size, undefined, (leaf) =>
    leaf.type.name.endsWith("_break") ? "\n" : "￼",
  );
}

function wordRange(state: EditorState): Range | null {
  const { $from } = state.selection;
  if (!$from.parent.inlineContent) return null;
  const text = blockText($from);
  const at = $from.parentOffset;
  for (const seg of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
    const end = seg.index + seg.segment.length;
    if (seg.isWordLike && seg.index <= at && at <= end) return { from: $from.start() + seg.index, to: $from.start() + end };
  }
  return null;
}

/** The line around the cursor: between the paragraph's line breaks. */
function lineRange(state: EditorState): Range | null {
  const { $from } = state.selection;
  if (!$from.parent.inlineContent) return null;
  const text = blockText($from);
  const at = $from.parentOffset;
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at);
  return { from: $from.start() + start, to: $from.start() + (end < 0 ? text.length : end) };
}

/** The run of text styled as the cursor's (its marks); the whole block when plain. */
function scopeRange(state: EditorState): Range | null {
  const { $from } = state.selection;
  if (!$from.parent.inlineContent) return null;
  const marks = $from.marks();
  const block = { from: $from.start(), to: $from.end() };
  if (!marks.length) return block;
  // Extend while every node keeps all of the cursor's marks.
  const has = (node: PMNode) => marks.every((m) => m.isInSet(node.marks));
  const parent = $from.parent;
  let index = $from.index();
  if (index >= parent.childCount || !has(parent.child(index))) index--;
  if (index < 0 || !has(parent.child(index))) return block;
  let first = index;
  let last = index;
  while (first > 0 && has(parent.child(first - 1))) first--;
  while (last < parent.childCount - 1 && has(parent.child(last + 1))) last++;
  let from = $from.start();
  for (let i = 0; i < first; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = first; i <= last; i++) to += parent.child(i).nodeSize;
  return { from, to };
}

function selectRange(get: (state: EditorState) => Range | null): Command {
  return (state, dispatch) => {
    const range = get(state);
    if (!range) return false;
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to)));
    return true;
  };
}

function deleteRange(get: (state: EditorState) => Range | null): Command {
  return (state, dispatch) => {
    const range = get(state);
    if (!range) return false;
    if (dispatch) dispatch(state.tr.delete(range.from, range.to).scrollIntoView());
    return true;
  };
}

/** Select Paragraph / Block: the block's text, then the block holding it. */
const selectBlock: Command = (state, dispatch) => {
  const { $from, from, to } = state.selection;
  if ($from.parent.inlineContent && (from !== $from.start() || to !== $from.end())) {
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.start(), $from.end())));
    return true;
  }
  const depth = $from.parent.inlineContent ? $from.depth - 1 : $from.depth;
  if (depth < 1) return false;
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, $from.before(depth))));
  return true;
};

/** The block a row move or block delete acts on: the list item holding the cursor's
 * paragraph, else the paragraph (or other block) itself. */
function rowDepth($from: ResolvedPos): number {
  let depth = $from.parent.inlineContent ? $from.depth : $from.depth + 1;
  if (depth > 1 && $from.node(depth - 1).type === schema.nodes.list_item && $from.index(depth - 1) === 0) depth--;
  return depth;
}

/** Delete Paragraph / Block. */
const deleteBlock: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const depth = rowDepth($from);
  if (depth < 1 || depth > $from.depth) return false;
  if (dispatch) dispatch(state.tr.deleteRange($from.before(depth), $from.after(depth)).scrollIntoView());
  return true;
};

/** Move Row Up / Down: a table row, else the list item or block, past its neighbour. */
function moveBlock(up: boolean): Command {
  const row = moveRow(up);
  return (state, dispatch, view) => {
    const at = tableAt(state);
    if (at) return at.row > 0 ? row(state, dispatch, view) : false;
    const { $from, $to, anchor, head } = state.selection;
    const depth = rowDepth($from);
    if (depth < 1 || depth > $from.depth || $to.before(depth) !== $from.before(depth)) return false;
    const parent = $from.node(depth - 1);
    const index = $from.index(depth - 1);
    const other = up ? index - 1 : index + 1;
    if (other < 0 || other >= parent.childCount) return false;
    if (dispatch) {
      const node = $from.node(depth);
      const from = $from.before(depth);
      const shift = up ? -parent.child(other).nodeSize : parent.child(other).nodeSize;
      const tr = state.tr.delete(from, from + node.nodeSize).insert(from + shift, node);
      const map = (pos: number) => pos + shift;
      tr.setSelection(
        state.selection instanceof NodeSelection
          ? NodeSelection.create(tr.doc, map(state.selection.from))
          : TextSelection.create(tr.doc, map(anchor), map(head)),
      );
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Transformations: change the case of the selected text, keeping its marks. */
function transform(change: (text: string) => string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) {
      const tr = state.tr;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) return;
        const start = Math.max(from, pos);
        const end = Math.min(to, pos + node.nodeSize);
        const text = node.text!.slice(start - pos, end - pos);
        const changed = change(text);
        if (changed !== text) tr.replaceWith(start, end, schema.text(changed, node.marks));
      });
      dispatch(tr.setSelection(TextSelection.create(tr.doc, from, to)));
    }
    return true;
  };
}

const capitalize = (text: string) => text.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

function jump(to: (doc: PMNode) => Selection): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.setSelection(to(state.doc)).scrollIntoView());
    return true;
  };
}

/** The selection's HTML, as ProseMirror serializes it for copying. */
function selectionHtml(state: EditorState): string {
  const div = document.createElement("div");
  div.append(DOMSerializer.fromSchema(schema).serializeFragment(state.selection.content().content));
  return div.innerHTML;
}

function copy(make: (state: EditorState) => { text: string; html?: string }): Command {
  return (state, dispatch) => {
    if (state.selection.empty) return false;
    if (dispatch) {
      const { text, html } = make(state);
      writeClipboard(text, html);
    }
    return true;
  };
}

export const editingCommands: Record<string, Command> = {
  "select-block": selectBlock,
  "select-line": selectRange(lineRange),
  "select-scope": selectRange(scopeRange),
  "select-word": selectRange(wordRange),
  "jump-top": jump((doc) => Selection.atStart(doc)),
  "jump-bottom": jump((doc) => Selection.atEnd(doc)),
  "jump-selection": (state, dispatch) => {
    if (dispatch) dispatch(state.tr.scrollIntoView());
    return true;
  },
  "move-row-up": moveBlock(true),
  "move-row-down": moveBlock(false),
  "delete-block": deleteBlock,
  "delete-line": deleteRange(lineRange),
  "delete-scope": deleteRange(scopeRange),
  "delete-word": deleteRange(wordRange),
  "upper-case": transform((t) => t.toUpperCase()),
  "lower-case": transform((t) => t.toLowerCase()),
  capitalize: transform(capitalize),
  "copy-plain": copy((state) => ({ text: state.doc.textBetween(state.selection.from, state.selection.to, "\n\n", "") })),
  "copy-markdown": copy((state) => ({ text: sliceMarkdown(state.selection.content()) })),
  "copy-html": copy((state) => ({ text: selectionHtml(state) })),
  "copy-no-style": copy((state) => ({ text: sliceMarkdown(state.selection.content()), html: selectionHtml(state) })),
};
