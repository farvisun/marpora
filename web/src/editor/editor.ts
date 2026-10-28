// Assembles the ProseMirror editor: schema, Typora behaviour and sync with the core.

import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, type Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { commands } from "./commands";
import { focusPlugin } from "./focus";
import { highlightPlugin } from "./highlight";
import { markdownInputRules } from "./inputrules";
import { mathPlugin } from "./mathblock";
import { hiddenSourceKeys } from "./navigation";
import { baseKeys, typoraKeymap } from "./keymap";
import { nodeViews, tocPlugin, type ViewContext } from "./nodeviews";
import { revealPlugin } from "./reveal";
import { tasksPlugin } from "./tasks";

export interface EditorOptions extends ViewContext {
  doc: PMNode;
  plugins?: Plugin[];
  onChange?: (view: EditorView) => void;
}

export function createEditor(mount: HTMLElement, opts: EditorOptions): EditorView {
  const state = EditorState.create({
    doc: opts.doc,
    plugins: [
      markdownInputRules(),
      typoraKeymap(),
      hiddenSourceKeys,
      baseKeys,
      history(),
      dropCursor(),
      gapCursor(),
      revealPlugin,
      tasksPlugin,
      focusPlugin,
      tocPlugin,
      highlightPlugin,
      mathPlugin,
      ...(opts.plugins ?? []),
    ],
  });
  const view: EditorView = new EditorView(
    { mount },
    {
      state,
      nodeViews: nodeViews(opts),
      attributes: { id: "write", class: "enable-diagrams", spellcheck: "true" },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged || tr.selectionSet) opts.onChange?.(view);
      },
    },
  );
  return view;
}

/** Run a command by menu id. Returns false when it does not apply here. */
export function runCommand(view: EditorView, id: string): boolean {
  const cmd = commands[id];
  if (!cmd) return false;
  const done = cmd(view.state, view.dispatch, view);
  view.focus();
  return done;
}
