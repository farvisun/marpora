// Edit › Whitespace and Line Breaks, as Typora has them: "Indent first line of
// paragraphs" (`#write.first-line-indent`) and "Preserve single line break", which
// shows soft breaks as the spaces they render as (`ignore-line-break`) while the file
// keeps them. The body class does the hiding; a space goes in beside each break.

import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

export interface Whitespace {
  indentFirstLine: boolean;
  ignoreLineBreak: boolean;
}

const key = new PluginKey<Whitespace>("marpora-whitespace");

function space(): HTMLElement {
  const el = document.createElement("span");
  el.className = "md-softbreak-space";
  el.textContent = " ";
  return el;
}

export const whitespacePlugin = new Plugin<Whitespace>({
  key,
  state: {
    init: () => ({ indentFirstLine: false, ignoreLineBreak: false }),
    apply: (tr, value) => tr.getMeta(key) ?? value,
  },
  props: {
    attributes(state): Record<string, string> {
      return key.getState(state)?.indentFirstLine ? { class: "first-line-indent" } : {};
    },
    decorations(state) {
      if (!key.getState(state)?.ignoreLineBreak) return null;
      const decos: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name === "soft_break") decos.push(Decoration.widget(pos, space, { side: -1, key: "sb" }));
        return !node.isLeaf;
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

export function setWhitespace(view: EditorView, value: Whitespace) {
  const now = key.getState(view.state);
  if (now?.indentFirstLine !== value.indentFirstLine || now?.ignoreLineBreak !== value.ignoreLineBreak) {
    view.dispatch(view.state.tr.setMeta(key, value).setMeta("addToHistory", false));
  }
}
