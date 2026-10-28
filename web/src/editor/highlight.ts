// Syntax highlighting for code fences and math blocks: CodeMirror 5's tokenizer turns each fence into
// `cm-*` inline decorations, the classes Typora themes colour. Fences stay ordinary
// ProseMirror text, so editing, undo and sync work as for any other block.
//
// Only fences touched by a transaction are re-tokenized; the rest of the set is mapped.

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { type CodeMirrorStatic, codemirror, loadMode, modeInfo } from "../cm";
import { langOf } from "./schema";

const key = new PluginKey<DecorationSet>("marpora-highlight");

/** Set on a transaction when a mode finished loading: re-highlight everything. */
const modesChanged = "marpora-highlight-modes";

let cm: CodeMirrorStatic | null = null;
/** Mode spec per language, `null` while loading or when there is none. */
const specs = new Map<string, string | null>();
let pendingView: EditorView | null = null;

function requestMode(lang: string) {
  if (specs.has(lang)) return;
  specs.set(lang, null);
  void (async () => {
    cm ??= await codemirror();
    const info = modeInfo(cm, lang);
    if (!info) return;
    try {
      specs.set(lang, await loadMode(info));
    } catch (e) {
      console.warn(`no highlighting for ${lang}:`, e);
      return;
    }
    const view = pendingView;
    if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(modesChanged, true));
  })();
}

/** Language a block is highlighted as: its info string, or TeX for math (as Typora). */
function langFor(node: PMNode): string | null {
  if (node.type.name === "code_block") return langOf(node);
  if (node.type.name === "math_block") return "latex";
  return null;
}

function fenceDecorations(node: PMNode, pos: number): Decoration[] {
  const lang = langFor(node);
  if (!lang) return [];
  const spec = specs.get(lang);
  if (spec === undefined) requestMode(lang);
  if (!spec || !cm) return [];
  const out: Decoration[] = [];
  let at = pos + 1;
  cm.runMode(node.textContent, spec, (text, style) => {
    if (style) {
      const cls = style
        .split(" ")
        .filter(Boolean)
        .map((s) => `cm-${s}`)
        .join(" ");
      out.push(Decoration.inline(at, at + text.length, { class: cls }));
    }
    at += text.length;
  });
  return out;
}

function collect(doc: PMNode, from: number, to: number, out: Decoration[]) {
  doc.nodesBetween(from, to, (node, pos) => {
    if (langFor(node) !== null) {
      out.push(...fenceDecorations(node, pos));
      return false;
    }
    return !node.isTextblock;
  });
}

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  collect(doc, 0, doc.content.size, decos);
  return DecorationSet.create(doc, decos);
}

/** Ranges of `tr.doc` that its steps touched. */
function changedRanges(tr: Transaction): [number, number][] {
  const ranges: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, start, end) => {
      ranges.push([rest.map(start, -1), rest.map(end, 1)]);
    });
  });
  return ranges;
}

function update(tr: Transaction, set: DecorationSet): DecorationSet {
  if (tr.getMeta(modesChanged)) return build(tr.doc);
  if (!tr.docChanged) return set;
  set = set.map(tr.mapping, tr.doc);
  for (const [from, to] of changedRanges(tr)) {
    // Whole fences around the change, so tokenizing starts at their first line.
    const fences: { node: PMNode; pos: number }[] = [];
    tr.doc.nodesBetween(from, Math.min(to, tr.doc.content.size), (node, pos) => {
      if (langFor(node) !== null) {
        fences.push({ node, pos });
        return false;
      }
      return !node.isTextblock;
    });
    for (const { node, pos } of fences) {
      const end = pos + node.nodeSize;
      set = set.remove(set.find(pos, end)).add(tr.doc, fenceDecorations(node, pos));
    }
  }
  return set;
}

export const highlightPlugin = new Plugin<DecorationSet>({
  key,
  state: {
    init: (_, state) => build(state.doc),
    apply: (tr, set) => update(tr, set),
  },
  props: {
    decorations: (state) => key.getState(state),
  },
  view(view) {
    pendingView = view;
    return {
      destroy() {
        if (pendingView === view) pendingView = null;
      },
    };
  },
});

