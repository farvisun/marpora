// Arrow keys into blocks whose source is hidden until the cursor is inside: math
// blocks and diagram fences show only their rendering, so the browser's own caret
// movement would skip over them.

import type { Node as PMNode } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { type Command, Selection, TextSelection } from "prosemirror-state";
import { diagramKind } from "../diagram";
import { langOf } from "./schema";

function hidesSource(node: PMNode): boolean {
  if (node.type.name === "math_block") return true;
  return node.type.name === "code_block" && diagramKind(langOf(node)) !== null;
}

function enter(dir: 1 | -1, unit: "up" | "down" | "left" | "right"): Command {
  return (state, dispatch, view) => {
    const { $head, empty } = state.selection;
    if (!empty || !view || $head.depth < 1 || !view.endOfTextblock(unit)) return false;
    const from = dir > 0 ? $head.after() : $head.before();
    const next = Selection.findFrom(state.doc.resolve(from), dir, true);
    if (!next || !hidesSource(next.$head.parent)) return false;
    if (dispatch) {
      const $m = next.$head;
      const pos = dir > 0 ? $m.start() : $m.end();
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView());
    }
    return true;
  };
}

export const hiddenSourceKeys = keymap({
  ArrowDown: enter(1, "down"),
  ArrowRight: enter(1, "right"),
  ArrowUp: enter(-1, "up"),
  ArrowLeft: enter(-1, "left"),
});
