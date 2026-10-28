// Find and replace in the document, as Typora does it: every match is marked
// `md-search-hit`, the current one also `md-search-select`, and moving between
// matches selects the current one (which reveals hidden source such as math).
//
// Matches never cross a text block or an inline atom (math, HTML, footnote marks).

import type { Node as PMNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/** Typora stops counting here. */
export const MAX_HITS = 5000;

export interface Hit {
  from: number;
  to: number;
}

interface SearchState {
  pattern: RegExp | null;
  hits: Hit[];
  current: number;
}

const key = new PluginKey<SearchState>("marpora-search");

/** Stands in for an inline atom, so no match spans one. */
const ATOM = "￼";

/** Matches of `pattern` (global) in `doc`, in document order. */
export function findHits(doc: PMNode, pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  doc.descendants((node, pos) => {
    if (hits.length >= MAX_HITS) return false;
    if (!node.isTextblock) return true;
    // One character per position: text, or an atom of size 1.
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text! : ATOM.repeat(child.nodeSize);
    });
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      if (!m[0]) {
        pattern.lastIndex++;
        continue;
      }
      if (m[0].includes(ATOM)) continue;
      hits.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      if (hits.length >= MAX_HITS) break;
    }
    return false;
  });
  return hits;
}

/** First hit at or after `pos`, wrapping to the first. */
function hitFrom(hits: Hit[], pos: number): number {
  if (!hits.length) return -1;
  const i = hits.findIndex((h) => h.from >= pos);
  return i < 0 ? 0 : i;
}

type Meta = { pattern: RegExp | null; from: number } | { current: number };

export const searchPlugin = new Plugin<SearchState>({
  key,
  state: {
    init: () => ({ pattern: null, hits: [], current: -1 }),
    apply(tr, value): SearchState {
      const meta = tr.getMeta(key) as Meta | undefined;
      if (meta && "pattern" in meta) {
        if (!meta.pattern) return { pattern: null, hits: [], current: -1 };
        const hits = findHits(tr.doc, meta.pattern);
        return { pattern: meta.pattern, hits, current: hitFrom(hits, meta.from) };
      }
      if (meta && "current" in meta) return { ...value, current: meta.current };
      if (!tr.docChanged || !value.pattern) return value;
      // Edited while searching: search again, keeping the place.
      const hits = findHits(tr.doc, value.pattern);
      const at = value.current >= 0 ? tr.mapping.map(value.hits[value.current].from) : 0;
      return { ...value, hits, current: hitFrom(hits, at) };
    },
  },
  props: {
    decorations(state) {
      const s = key.getState(state);
      if (!s?.hits.length) return DecorationSet.empty;
      return DecorationSet.create(
        state.doc,
        s.hits.map((h, i) =>
          Decoration.inline(h.from, h.to, { class: i === s.current ? "md-search-hit md-search-select" : "md-search-hit" }),
        ),
      );
    },
  },
});

export interface SearchStatus {
  count: number;
  /** Index of the current match, or -1. */
  current: number;
}

export function searchStatus(state: EditorState): SearchStatus {
  const s = key.getState(state);
  return { count: s?.hits.length ?? 0, current: s?.current ?? -1 };
}

function select(tr: Transaction, hit: Hit | undefined): Transaction {
  return hit ? tr.setSelection(TextSelection.create(tr.doc, hit.from, hit.to)).scrollIntoView() : tr;
}

/**
 * Search for `pattern` (null clears), starting from `from`. With `selectHit`, the
 * current match becomes the selection.
 */
export function setSearch(view: EditorView, pattern: RegExp | null, from: number, selectHit = true) {
  let tr = view.state.tr.setMeta(key, { pattern, from });
  const next = view.state.apply(tr);
  const s = key.getState(next)!;
  if (selectHit) tr = select(tr, s.hits[s.current]);
  view.dispatch(tr);
}

/** Move to the next (1) or previous (-1) match. */
export function stepSearch(view: EditorView, dir: 1 | -1) {
  const s = key.getState(view.state)!;
  if (!s.hits.length) return;
  const current = (s.current + dir + s.hits.length) % s.hits.length;
  view.dispatch(select(view.state.tr.setMeta(key, { current }), s.hits[current]));
}

/** `replacement` for the matched `text`, expanding `$1` and friends for a regexp. */
function expand(text: string, pattern: RegExp, replacement: string, regexp: boolean): string {
  if (!regexp) return replacement;
  return text.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
}

/** Replace the current match and move to the next. */
export function replaceCurrent(view: EditorView, replacement: string, regexp: boolean) {
  const s = key.getState(view.state)!;
  const hit = s.hits[s.current];
  if (!hit || !s.pattern) return;
  const text = view.state.doc.textBetween(hit.from, hit.to);
  const tr = view.state.tr.insertText(expand(text, s.pattern, replacement, regexp), hit.from, hit.to);
  // The plugin searches again and lands on the match after this one.
  const next = view.state.apply(tr);
  const n = key.getState(next)!;
  view.dispatch(select(tr, n.hits[n.current]));
}

/** Replace every match in one step; returns how many were replaced. */
export function replaceAll(view: EditorView, replacement: string, regexp: boolean): number {
  const s = key.getState(view.state)!;
  if (!s.hits.length || !s.pattern) return 0;
  const tr = view.state.tr;
  for (let i = s.hits.length - 1; i >= 0; i--) {
    const { from, to } = s.hits[i];
    tr.insertText(expand(view.state.doc.textBetween(from, to), s.pattern, replacement, regexp), from, to);
  }
  view.dispatch(tr);
  return s.hits.length;
}
