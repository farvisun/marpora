// Editor commands, keyed by the ids the native menu sends (see src-tauri/src/menu.rs).

import { chainCommands, exitCode, joinBackward, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import type { MarkType, Node as PMNode, NodeType } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, type EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { schema } from "./schema";

const n = schema.nodes;
const m = schema.marks;

function inNode(state: EditorState, type: NodeType): number | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return d;
  return null;
}

/** ⌘1…⌘6: heading of that level, or back to a paragraph if it already is one. */
export function toggleHeading(level: number): Command {
  return (state, dispatch) => {
    const parent = state.selection.$from.parent;
    if (parent.type === n.heading && parent.attrs.level === level) {
      return setBlockType(n.paragraph)(state, dispatch);
    }
    return setBlockType(n.heading, { level })(state, dispatch);
  };
}

/** ⌘= / ⌘-: promote or demote the heading level (paragraph ⇄ H6 at the edges). */
export function shiftHeading(delta: -1 | 1): Command {
  return (state, dispatch) => {
    const parent = state.selection.$from.parent;
    if (parent.type === n.paragraph) {
      return delta > 0 ? setBlockType(n.heading, { level: 6 })(state, dispatch) : false;
    }
    if (parent.type !== n.heading) return false;
    const level = parent.attrs.level - delta;
    if (level > 6) return setBlockType(n.paragraph)(state, dispatch);
    return setBlockType(n.heading, { level: Math.max(1, level) })(state, dispatch);
  };
}

function toggleWrap(type: NodeType): Command {
  return (state, dispatch) =>
    inNode(state, type) !== null ? lift(state, dispatch) : wrapIn(type)(state, dispatch);
}

function toggleList(type: NodeType, task = false): Command {
  return (state, dispatch, view) => {
    const depth = inNode(state, n.list_item);
    if (depth !== null) {
      const list = state.selection.$from.node(depth - 1);
      const item = state.selection.$from.node(depth);
      const isTask = item.attrs.checked !== null;
      if (list.type === type && isTask === task) return liftListItem(n.list_item)(state, dispatch);
    }
    if (!wrapInList(type)(state, undefined)) return false;
    if (!dispatch) return true;
    return wrapInList(type)(state, (tr) => {
      if (task) {
        const { $from } = tr.selection;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type === n.list_item) {
            tr.setNodeMarkup($from.before(d), null, { checked: false });
            break;
          }
        }
      }
      dispatch(tr);
    }, view);
  };
}

/** Replace the current block with `node` and put the cursor inside or after it. */
function insertBlock(make: () => PMNode): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const depth = $from.depth > 0 ? 1 : 0;
    if (!dispatch) return true;
    const node = make();
    const empty = $from.parent.content.size === 0 && $from.parent.isTextblock;
    const from = empty ? $from.before(depth || 1) : $from.after(depth || 1);
    const to = empty ? $from.after(depth || 1) : from;
    const tr = state.tr.replaceWith(from, to, node);
    const inside = from + 1;
    if (node.isTextblock || node.type.spec.code) {
      tr.setSelection(TextSelection.create(tr.doc, inside));
    } else if (node.isAtom) {
      tr.setSelection(NodeSelection.create(tr.doc, from));
    } else {
      tr.setSelection(TextSelection.near(tr.doc.resolve(inside)));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function createTable(cols: number, bodyRows: number, headers?: string[]): PMNode {
  const cell = (type: NodeType, text?: string) => type.create(null, text ? schema.text(text) : null);
  const row = (type: NodeType, texts?: string[]) =>
    n.table_row.create(null, Array.from({ length: cols }, (_, i) => cell(type, texts?.[i])));
  return n.table.create(null, [
    n.table_head.create(null, row(n.table_header, headers)),
    n.table_body.create(null, Array.from({ length: bodyRows }, () => row(n.table_cell))),
  ]);
}

function toggleMarkCmd(type: MarkType, attrs?: Record<string, unknown>): Command {
  return toggleMark(type, attrs);
}

/** ⌘\: remove all inline formatting from the selection. */
const clearFormat: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (dispatch) dispatch(state.tr.removeMark(from, to));
  return true;
};

/** Backspace at the start of a block undoes its block formatting first, like Typora. */
export const backspaceBlock: Command = (state, dispatch, view) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parentOffset > 0) return false;
  const parent = $cursor.parent;
  if (parent.type === n.heading) return setBlockType(n.paragraph)(state, dispatch);
  const item = inNode(state, n.list_item);
  if (item !== null && $cursor.index(item) === 0 && $cursor.depth === item + 1) {
    const li = $cursor.node(item);
    if (li.attrs.checked !== null) {
      if (dispatch) dispatch(state.tr.setNodeMarkup($cursor.before(item), null, { checked: null }));
      return true;
    }
    return liftListItem(n.list_item)(state, dispatch, view);
  }
  const quote = inNode(state, n.blockquote);
  if (quote !== null && $cursor.index(quote) === 0) return lift(state, dispatch);
  return false;
};

export const commands: Record<string, Command> = {
  undo,
  redo,
  strong: toggleMarkCmd(m.strong),
  em: toggleMarkCmd(m.em),
  code: toggleMarkCmd(m.code),
  strike: toggleMarkCmd(m.strike),
  highlight: toggleMarkCmd(m.highlight),
  "clear-format": clearFormat,
  link: toggleMarkCmd(m.link, { href: "" }),
  paragraph: setBlockType(n.paragraph),
  "heading-1": toggleHeading(1),
  "heading-2": toggleHeading(2),
  "heading-3": toggleHeading(3),
  "heading-4": toggleHeading(4),
  "heading-5": toggleHeading(5),
  "heading-6": toggleHeading(6),
  "heading-up": shiftHeading(1),
  "heading-down": shiftHeading(-1),
  quote: toggleWrap(n.blockquote),
  "ordered-list": toggleList(n.ordered_list),
  "bullet-list": toggleList(n.bullet_list),
  "task-list": toggleList(n.bullet_list, true),
  indent: sinkListItem(n.list_item),
  outdent: liftListItem(n.list_item),
  "code-fence": insertBlock(() => n.code_block.create()),
  "math-block": insertBlock(() => n.math_block.create()),
  table: insertBlock(() => createTable(2, 2)),
  hr: insertBlock(() => n.horizontal_rule.create()),
  toc: insertBlock(() => n.toc.create()),
};

export const listEnter = splitListItem(n.list_item);
export const exitCodeBlock = exitCode;
export const backspace = chainCommands(backspaceBlock, joinBackward);
