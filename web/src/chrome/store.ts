// UI state shared by the chrome (sidebar, footer) and the editor.

import type { Node as PMNode } from "prosemirror-model";
import { createStore } from "solid-js/store";

export interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

export interface Counts {
  words: number;
  chars: number;
  lines: number;
}

export const [ui, setUi] = createStore({
  sidebar: false,
  sidebarTab: "outline" as "outline" | "files",
  outline: [] as OutlineItem[],
  activeHeading: -1,
  counts: { words: 0, chars: 0, lines: 0 } as Counts,
  focusMode: false,
  typewriterMode: false,
  sourceMode: false,
  theme: "marpora",
  path: null as string | null,
  dirty: false,
  /** The find and replace panel (chrome/search.ts). */
  search: {
    open: false,
    replace: false,
    /** "1 / 3", "No Results", ... */
    status: "",
    error: false,
    /** "Replaced 3 occurrence(s)", with an Undo button, for a few seconds. */
    message: null as string | null,
    options: { caseSensitive: false, wholeWord: false, regexp: false },
    /** Bumped on every open, to focus the search box. */
    focus: 0,
  },
});

export function outlineOf(doc: PMNode): OutlineItem[] {
  const out: OutlineItem[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name === "heading") out.push({ level: node.attrs.level, text: node.textContent, pos });
  });
  return out;
}

// CJK characters count as one word each, like Typora.
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function countText(text: string): Counts {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, " ").match(WORD)?.length ?? 0;
  return {
    words: cjk + latin,
    chars: text.replace(/\s/g, "").length,
    lines: text ? text.split("\n").length : 0,
  };
}

export function docText(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, "\n", " ");
}
