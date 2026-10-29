// Inline AI (AI › Ask AI…, ⇧⌘J): the requests that rewrite the selection or write at the
// cursor, with the whole document as context, and the plugin that keeps the target
// marked while the prompt has the focus.

import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { AiRequest } from "../ipc";
import { serializeDoc } from "../md";
import { sliceMarkdown } from "./clipboard";

export interface Preset {
  id: string;
  label: string;
  /** What to ask for; the selection (or the text before the cursor) comes with it. */
  instruction: string;
}

export const PRESETS: Preset[] = [
  { id: "improve", label: "Improve Writing", instruction: "Improve the writing: clearer, smoother and more precise, keeping the meaning, tone and language." },
  { id: "fix", label: "Fix Spelling and Grammar", instruction: "Fix spelling, grammar and punctuation. Change nothing else." },
  { id: "shorter", label: "Make Shorter", instruction: "Make it shorter, keeping what matters." },
  { id: "longer", label: "Make Longer", instruction: "Make it longer, with more detail in the same voice." },
  { id: "simplify", label: "Simplify Language", instruction: "Rewrite it in simpler words and shorter sentences." },
  { id: "summarize", label: "Summarize", instruction: "Summarize it in a few sentences." },
  { id: "translate", label: "Translate…", instruction: "Translate it to " },
  { id: "continue", label: "Continue Writing", instruction: "Continue writing from the cursor, in the same voice." },
];

const SYSTEM = `You are the writing assistant in Marpora, a Markdown editor. The user's document is \
below, between <document> tags. When asked to rewrite a passage, reply with only its \
replacement; when asked to write at the cursor, reply with only the new text. Write \
Markdown in the document's style, never wrap the reply in a code fence, and add no \
notes, quotes or preamble around it.`;

/** The part of the document the request works on: [from, to), or a cursor when equal. */
export interface Target {
  from: number;
  to: number;
}

/** The request for `instruction` on `target` in `state`'s document. */
export function aiRequest(state: EditorState, target: Target, instruction: string): AiRequest {
  const doc = state.doc;
  const document = serializeDoc(doc);
  let content: string;
  if (target.from < target.to) {
    const selection = sliceMarkdown(doc.slice(target.from, target.to));
    content = `Rewrite this passage of the document:\n<passage>\n${selection}\n</passage>\n\n${instruction}`;
  } else {
    // The tail of what comes before the cursor shows where to write.
    const before = serializeDoc(doc.cut(0, target.from)).trimEnd().slice(-1500);
    content = `Write at the cursor, which follows this text:\n<before-cursor>\n${before}\n</before-cursor>\n\n${instruction}`;
  }
  return {
    system: `${SYSTEM}\n\n<document>\n${document}</document>`,
    messages: [{ role: "user", content }],
  };
}

/** The answer as Markdown to put in: a reply wrapped in one code fence anyway is unwrapped. */
export function cleanAnswer(text: string): string {
  const fenced = /^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return (fenced ? fenced[1] : text).replace(/^\n+|\s+$/g, "");
}

const targetKey = new PluginKey<Target | null>("ai-target");

/** Marks the AI's target (`.md-ai-target`, or a caret at a cursor) and keeps it in place
 * through edits made while the prompt is open. */
export function aiTarget(): Plugin<Target | null> {
  return new Plugin<Target | null>({
    key: targetKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const set = tr.getMeta(targetKey);
        if (set !== undefined) return set;
        if (!value || !tr.docChanged) return value;
        const from = tr.mapping.map(value.from, 1);
        return { from, to: Math.max(from, tr.mapping.map(value.to, -1)) };
      },
    },
    props: {
      decorations(state) {
        const t = targetKey.getState(state);
        if (!t) return null;
        const marks =
          t.from < t.to
            ? [Decoration.inline(t.from, t.to, { class: "md-ai-target" })]
            : [Decoration.widget(t.from, () => Object.assign(document.createElement("span"), { className: "md-ai-caret" }), { side: 1 })];
        return DecorationSet.create(state.doc, marks);
      },
    },
  });
}

export function setAiTarget(view: EditorView, target: Target | null) {
  view.dispatch(view.state.tr.setMeta(targetKey, target).setMeta("addToHistory", false));
}

export function aiTargetOf(state: EditorState): Target | null {
  return targetKey.getState(state) ?? null;
}
