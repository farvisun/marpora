// View › Readonly Mode: nothing the user does changes the document, whether typed,
// pasted, run from a menu or done in a node view's own text box (a formula's TeX, a
// fence's language). Changes from outside (the file changed on disk, a resync with the
// core) still apply, so the editor keeps showing the file.

import { type EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** sync.ts's `remoteMeta`, here so this module does not load the parser. */
const remoteMeta = "marpora-remote";

const readonlyKey = new PluginKey<boolean>("marpora-readonly");

export function isReadonly(state: EditorState): boolean {
  return readonlyKey.getState(state) ?? false;
}

export function setReadonly(view: EditorView, on: boolean) {
  view.dispatch(view.state.tr.setMeta(readonlyKey, on));
}

/** A change from outside the editor, or one a plugin appended to it. */
function fromOutside(tr: Transaction): boolean {
  const root: Transaction = tr.getMeta("appendedTransaction") ?? tr;
  return !!root.getMeta(remoteMeta);
}

export const readonlyPlugin = new Plugin<boolean>({
  key: readonlyKey,
  state: {
    init: () => false,
    apply: (tr, on) => tr.getMeta(readonlyKey) ?? on,
  },
  filterTransaction: (tr, state) => !tr.docChanged || !isReadonly(state) || fromOutside(tr),
  props: {
    editable: (state) => !isReadonly(state),
  },
  view(view) {
    // Node views' text boxes are outside ProseMirror's editing; stop input there too.
    const stop = (e: Event) => {
      if (!view.editable) e.preventDefault();
    };
    view.dom.addEventListener("beforeinput", stop, true);
    return { destroy: () => view.dom.removeEventListener("beforeinput", stop, true) };
  },
});
