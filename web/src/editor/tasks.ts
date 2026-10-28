// Task list checkboxes, rendered as `li > input + p` like Typora.

import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

function checkbox(checked: boolean) {
  return (view: EditorView, getPos: () => number | undefined) => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.contentEditable = "false";
    input.addEventListener("mousedown", (e) => e.preventDefault());
    input.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      const itemPos = pos - 1;
      const item = view.state.doc.nodeAt(itemPos);
      if (!item || item.type.name !== "list_item") return;
      view.dispatch(view.state.tr.setNodeMarkup(itemPos, null, { ...item.attrs, checked: !item.attrs.checked }));
    });
    return input;
  };
}

function build(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === "list_item" && node.attrs.checked !== null) {
      decos.push(
        Decoration.widget(pos + 1, checkbox(node.attrs.checked), {
          side: -1,
          ignoreSelection: true,
          key: `task:${node.attrs.checked}`,
        }),
      );
    }
    // Lists and tasks only live in block containers; skip inline content.
    return !node.isTextblock;
  });
  return DecorationSet.create(state.doc, decos);
}

const key = new PluginKey<DecorationSet>("marpora-tasks");

export const tasksPlugin = new Plugin<DecorationSet>({
  key,
  state: {
    init: (_, state) => build(state),
    apply: (tr, old, _prev, state) => (tr.docChanged ? build(state) : old),
  },
  props: {
    decorations: (state) => key.getState(state),
  },
});
