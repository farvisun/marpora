// What a right click in the editor is on, for the native context menu the backend
// builds (src-tauri context_menu.rs), as Typora's getMenuItemsForMac works it out: a
// link, a table, a code, math or HTML block, and the styles to show checked.

import type { ResolvedPos } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { linkAt } from "./links";
import { schema } from "./schema";

export interface MenuContext {
  editor: boolean;
  link?: boolean;
  table?: boolean;
  block?: "code" | "math" | "html" | null;
  /** Menu ids of the styles at the cursor. */
  active?: string[];
}

const n = schema.nodes;
const MARKS: Record<string, string> = { strong: "strong", em: "em", code: "code", strike: "strike", highlight: "highlight", link: "link" };

/** The menu ids of the styles at `$from` (the selection's start by default): its marks,
 * its block and the blocks around it. */
export function activeStyles(state: EditorState, $from: ResolvedPos = state.selection.$from): string[] {
  const marks = $from.pos === state.selection.from && state.storedMarks ? state.storedMarks : $from.marks();
  const active = marks.map((m) => MARKS[m.type.name]).filter(Boolean);
  const block = $from.parent;
  if (block.type === n.heading) active.push(`heading-${block.attrs.level}`);
  else if (block.type === n.paragraph) active.push("paragraph");
  for (let d = $from.depth - 1; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === n.blockquote) active.push("quote");
    else if (node.type === n.ordered_list) active.push("ordered-list");
    else if (node.type === n.bullet_list) active.push("bullet-list");
    else if (node.type === n.list_item && node.attrs.checked !== null) active.push("task-list");
  }
  return [...new Set(active)];
}

/** The context of a right click on `target` at (`x`, `y`). */
export function menuContext(view: EditorView, target: EventTarget | null, x: number, y: number): MenuContext {
  if (!(target instanceof Node) || !view.dom.contains(target) || !view.editable) return { editor: false };
  const { state } = view;
  // WebKit keeps a selection clicked inside, and moves the cursor to the click otherwise.
  const at = view.posAtCoords({ left: x, top: y })?.pos ?? state.selection.from;
  const { from, to } = state.selection;
  const pos = at >= from && at <= to ? from : at;
  const $pos = state.doc.resolve(pos);
  let table = false;
  let block: MenuContext["block"] = null;
  for (let d = $pos.depth; d > 0; d--) {
    const type = $pos.node(d).type;
    if (type === n.table) table = true;
    else if (type === n.code_block) block = "code";
    else if (type === n.math_block) block = "math";
    else if (type === n.html_block) block = "html";
  }
  const element = target instanceof Element ? target : target.parentElement;
  if (element?.closest(".md-fences")) block = "code";
  else if (element?.closest(".md-math-block")) block = "math";
  else if (element?.closest(".md-htmlblock")) block = "html";
  const link = !!element?.closest("a[href], .md-link") || !!linkAt(state, pos)?.attrs.href;
  return { editor: true, link, table, block, active: activeStyles(state, $pos) };
}

/** Tell `send` the context of each right click in `view`: on the mouse down, so it is
 * there before the menu opens, and again as the menu is asked for. */
export function trackContextMenu(view: () => EditorView, enabled: () => boolean, send: (cx: MenuContext) => void) {
  const report = (e: MouseEvent) => send(enabled() ? menuContext(view(), e.target, e.clientX, e.clientY) : { editor: false });
  document.addEventListener("mousedown", (e) => (e.button === 2 || (e.button === 0 && e.ctrlKey)) && report(e), true);
  document.addEventListener("contextmenu", report, true);
}
