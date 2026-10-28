// Typora marks the block holding the cursor with `md-focus` and its containers with
// `md-focus-container`; themes and focus mode (F8) style them.

import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** Whether a node view's decorations mark it as the block holding the cursor. */
export function isFocused(decorations: readonly Decoration[]): boolean {
  return decorations.some((d) => d.spec.focus);
}

function build(state: EditorState): DecorationSet {
  const { $head } = state.selection;
  const decos: Decoration[] = [];
  for (let d = 1; d <= $head.depth; d++) {
    const from = $head.before(d);
    const node = $head.node(d);
    const cls = d === $head.depth ? "md-focus" : "md-focus-container";
    decos.push(Decoration.node(from, from + node.nodeSize, { class: cls }, { focus: d === $head.depth }));
  }
  return DecorationSet.create(state.doc, decos);
}

export const focusPlugin = new Plugin({
  key: new PluginKey("marpora-focus"),
  props: {
    decorations: build,
  },
});
