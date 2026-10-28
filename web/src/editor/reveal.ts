// Typora's "seamless" inline syntax: markdown delimiters of the marks around the cursor
// are shown in place (`**bold**`), and hidden again when the cursor leaves.

import type { Mark, Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export function delimiters(mark: Mark): [string, string] | null {
  const a = mark.attrs;
  switch (mark.type.name) {
    case "strong":
    case "em":
      return [a.markup, a.markup];
    case "code":
      return ["`", "`"];
    case "strike":
      return ["~~", "~~"];
    case "highlight":
      return ["==", "=="];
    case "sup":
      return ["^", "^"];
    case "sub":
      return ["~", "~"];
    case "link":
      if (a.kind === "bare") return null;
      if (a.kind === "angle") return ["<", ">"];
      return ["[", `](${a.href}${a.title ? ` "${a.title}"` : ""})`];
    default:
      return null;
  }
}

/** Offsets (within `parent`) of the run of children around `index` that carry `mark`. */
function markRun(parent: PMNode, index: number, mark: Mark): [number, number] {
  let start = index;
  while (start > 0 && mark.isInSet(parent.child(start - 1).marks)) start--;
  let end = index;
  while (end < parent.childCount - 1 && mark.isInSet(parent.child(end + 1).marks)) end++;
  let from = 0;
  for (let i = 0; i < start; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = start; i <= end; i++) to += parent.child(i).nodeSize;
  return [from, to];
}

function meta(text: string, side: "before" | "after") {
  const span = document.createElement("span");
  span.className = `md-meta md-${side}`;
  span.textContent = text;
  return span;
}

export function revealDecorations(state: EditorState): DecorationSet {
  const { $head } = state.selection;
  const parent = $head.parent;
  if (!parent.inlineContent || parent.type.spec.code) return DecorationSet.empty;

  const decos: Decoration[] = [];
  const seen = new Set<Mark>();
  const base = $head.start();
  const candidates: [PMNode | null, number][] = [
    [$head.nodeBefore, $head.index() - 1],
    [$head.nodeAfter, $head.index()],
  ];
  for (const [node, index] of candidates) {
    if (!node || index < 0) continue;
    for (const mark of node.marks) {
      if (seen.has(mark)) continue;
      seen.add(mark);
      const delims = delimiters(mark);
      if (!delims) continue;
      const [from, to] = markRun(parent, index, mark);
      const key = `${mark.type.name}:${base + from}`;
      decos.push(
        Decoration.widget(base + from, meta(delims[0], "before"), { side: -1, marks: [], key: `${key}:b:${delims[0]}` }),
        Decoration.widget(base + to, meta(delims[1], "after"), { side: 1, marks: [], key: `${key}:a:${delims[1]}` }),
        Decoration.inline(base + from, base + to, { class: "md-expand" }),
      );
    }
  }
  return DecorationSet.create(state.doc, decos);
}

export const revealPlugin = new Plugin({
  key: new PluginKey("marpora-reveal"),
  props: {
    decorations: revealDecorations,
  },
});
