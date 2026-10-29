// Typora keyboard behaviour. Menu shortcuts (⌘1, ⌘B, …) arrive as menu events on macOS
// and run the same commands; binding them here too covers the browser build.

import { baseKeymap, chainCommands, liftEmptyBlock, newlineInCode, splitBlock } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { type Command, Selection, TextSelection } from "prosemirror-state";
import { liftListItem } from "prosemirror-schema-list";
import { backspace, commands, createTable, listEnter } from "./commands";
import { schema } from "./schema";

const n = schema.nodes;

/** Paragraph text that becomes a block when Enter is pressed at its end. */
function enterBlock(text: string): PMNode | null {
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(`{3,}|~{3,})([^`]*)$/))) {
    return n.code_block.create({ fence: match[1], info: match[2].trim() });
  }
  if (text === "$$") return n.math_block.create();
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) return n.horizontal_rule.create({ markup: text });
  if (/^\[toc\]$/i.test(text)) return n.toc.create();
  if ((match = text.match(/^\|(.+)\|$/))) {
    const headers = match[1].split("|").map((h) => h.trim());
    return createTable(headers.length, 1, headers);
  }
  return null;
}

const convertOnEnter: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type !== n.paragraph) return false;
  if ($cursor.parentOffset !== $cursor.parent.content.size) return false;
  const node = enterBlock($cursor.parent.textContent);
  if (!node) return false;
  if (!dispatch) return true;
  const from = $cursor.before();
  const to = $cursor.after();
  const tr = state.tr.replaceWith(from, to, node);
  if (node.isTextblock) {
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
  } else if (node.type === n.table) {
    // Into the first body cell.
    const headSize = node.child(0).nodeSize;
    tr.setSelection(Selection.near(tr.doc.resolve(from + 1 + headSize + 1)));
  } else {
    const after = from + node.nodeSize;
    if (after >= tr.doc.content.size) tr.insert(after, n.paragraph.create());
    tr.setSelection(Selection.near(tr.doc.resolve(after + 1)));
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/** Enter in an empty list item leaves the list (or moves up one level), like Typora. */
const emptyItemEnter: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.content.size > 0 || $cursor.depth < 2) return false;
  if ($cursor.node(-1).type !== n.list_item) return false;
  return liftListItem(n.list_item)(state, dispatch);
};

/** Enter inside a table cell moves to (or creates) the cell below, like Typora. */
const tableEnter: Command = (state, dispatch) => {
  const { $from } = state.selection;
  let depth = $from.depth;
  while (depth > 0 && !["table_cell", "table_header"].includes($from.node(depth).type.name)) depth--;
  if (depth === 0) return false;
  if (!dispatch) return true;
  const rowDepth = depth - 1;
  const row = $from.node(rowDepth);
  const col = $from.index(rowDepth);
  const sectionDepth = rowDepth - 1;
  const tableDepth = sectionDepth - 1;
  const table = $from.node(tableDepth);
  const tablePos = $from.before(tableDepth);
  const inHead = $from.node(sectionDepth).type === n.table_head;
  const body = table.child(1);
  const rowIndex = inHead ? -1 : $from.index(sectionDepth);
  const tr = state.tr;
  let rowPos: number;
  if (rowIndex + 1 < body.childCount) {
    rowPos = tablePos + 1 + table.child(0).nodeSize + 1;
    for (let i = 0; i <= rowIndex; i++) rowPos += body.child(i).nodeSize;
  } else {
    const cells = Array.from({ length: row.childCount }, () => n.table_cell.create());
    rowPos = tablePos + 1 + table.child(0).nodeSize + 1 + body.content.size;
    tr.insert(rowPos, n.table_row.create(null, cells));
  }
  let cellPos = rowPos + 1;
  const newRow = tr.doc.nodeAt(rowPos)!;
  for (let i = 0; i < col; i++) cellPos += newRow.child(i).nodeSize;
  tr.setSelection(TextSelection.create(tr.doc, cellPos + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

export function typoraKeymap() {
  const c = commands;
  return keymap({
    Enter: chainCommands(newlineInCode, tableEnter, convertOnEnter, emptyItemEnter, listEnter, liftEmptyBlock, splitBlock),
    "Shift-Enter": (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(n.soft_break.create()).scrollIntoView());
      return true;
    },
    "Mod-Enter": c["table-row-below"],
    "Shift-Mod-Backspace": c["table-delete-row"],
    "Ctrl-Mod-ArrowUp": c["table-row-up"],
    "Ctrl-Mod-ArrowDown": c["table-row-down"],
    "Ctrl-Mod-ArrowLeft": c["table-col-left"],
    "Ctrl-Mod-ArrowRight": c["table-col-right"],
    Backspace: backspace,
    Tab: c.indent,
    "Shift-Tab": c.outdent,
    "Mod-z": c.undo,
    "Shift-Mod-z": c.redo,
    "Mod-y": c.redo,
    "Mod-b": c.strong,
    "Mod-i": c.em,
    "Mod-\\": c["clear-format"],
    "Mod-k": c.link,
    [mac ? "Ctrl-`" : "Ctrl-Shift-`"]: c.code,
    [mac ? "Ctrl-Shift-`" : "Alt-Shift-5"]: c.strike,
    "Mod-Shift-h": c.highlight,
    "Mod-u": c.underline,
    "Ctrl-m": c["inline-math"],
    "Ctrl-Mod-i": c["insert-image"],
    "Ctrl-x": c["task-toggle"],
    "Mod-Alt-l": c["link-reference"],
    "Mod-Alt-r": c.footnote,
    "Ctrl--": c.comment,
    "Mod-0": c.paragraph,
    "Mod-1": c["heading-1"],
    "Mod-2": c["heading-2"],
    "Mod-3": c["heading-3"],
    "Mod-4": c["heading-4"],
    "Mod-5": c["heading-5"],
    "Mod-6": c["heading-6"],
    "Mod-=": c["heading-up"],
    "Mod--": c["heading-down"],
    "Mod-Alt-q": c.quote,
    "Mod-Alt-o": c["ordered-list"],
    "Mod-Alt-u": c["bullet-list"],
    "Mod-Alt-x": c["task-list"],
    "Mod-Alt-c": c["code-fence"],
    "Mod-Alt-b": c["math-block"],
    "Mod-Alt-t": c.table,
    "Mod-Alt--": c.hr,
    "Mod-]": c.indent,
    "Mod-[": c.outdent,
  });
}

export const baseKeys = keymap(baseKeymap);
