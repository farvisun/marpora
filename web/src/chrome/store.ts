// UI state shared by the chrome (sidebar, footer) and the editor.

import type { Node as PMNode } from "prosemirror-model";
import { createStore } from "solid-js/store";
import type { FileSearchResults, Settings } from "../ipc";

/** Sidebar state kept across reloads of the window (opening a file reloads it). */
interface SidebarState {
  sidebar: boolean;
  sidebarTab: "outline" | "files";
  /** The Files tab shows the tree rather than the article list. */
  fileTree: boolean;
}

const SIDEBAR_KEY = "marpora.sidebar";

export const DELIMITER_KEY = "marpora.wordCountDelimiter";

/** The status bar's count (chrome/WordCount.tsx), as last picked in this app. */
function savedDelimiter(): number {
  try {
    const d = Number(localStorage.getItem(DELIMITER_KEY));
    return d >= 0 && d <= 3 ? d : 0;
  } catch {
    return 0;
  }
}

function savedSidebar(): SidebarState {
  const defaults: SidebarState = { sidebar: false, sidebarTab: "outline", fileTree: false };
  try {
    return { ...defaults, ...JSON.parse(sessionStorage.getItem(SIDEBAR_KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

/** Remember the sidebar for when this window reloads. */
export function saveSidebar() {
  try {
    const { sidebar, sidebarTab, fileTree } = ui;
    sessionStorage.setItem(SIDEBAR_KEY, JSON.stringify({ sidebar, sidebarTab, fileTree }));
  } catch {
    // Not remembered; the sidebar starts closed after a reload.
  }
}

export type LibrarySort = Pick<Settings, "listSort" | "treeSort" | "listNoGroup" | "treeNoGroup">;

export function librarySortOf(s: Settings): LibrarySort {
  const { listSort, treeSort, listNoGroup, treeNoGroup } = s;
  return { listSort, treeSort, listNoGroup, treeNoGroup };
}

export interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

export interface Counts {
  words: number;
  chars: number;
  lines: number;
  /** Words and characters in the selection. */
  selWords: number;
  selChars: number;
}

export const [ui, setUi] = createStore({
  ...savedSidebar(),
  outline: [] as OutlineItem[],
  activeHeading: -1,
  counts: { words: 0, chars: 0, lines: 0, selWords: 0, selChars: 0 } as Counts,
  /** The status bar's word count popover is showing (View › Toggle Word Count Popover). */
  wordCountPopover: false,
  /** View › Toggle Outline Popover. */
  outlinePopover: false,
  /** What the status bar counts: Typora's delimiter, 0 words, 1 characters, 2 lines, 3 minutes. */
  wordDelimiter: savedDelimiter(),
  focusMode: false,
  typewriterMode: false,
  sourceMode: false,
  theme: "marpora",
  path: null as string | null,
  dirty: false,
  /** Quick Open (⇧⌘O) is showing. */
  quickOpen: false,
  /** Paragraph › Table › Insert Table's dialog is showing. */
  tableDialog: false,
  /** AI › Ask AI's prompt (chrome/InlineAi.tsx): its starting text, and whether to run
   * it at once (a preset); bumped `seq` reopens it. */
  inlineAi: null as { instruction: string; run: boolean; seq: number } | null,
  /** AI › AI Chat's panel is showing (chrome/AiChat.tsx). */
  aiChat: false,
  /** View › Slide Preview is showing (chrome/SlidePreview.tsx). */
  slidePreview: false,
  /** The document is a Marp deck (`marp: true`). */
  deck: false,
  /** The slide holding the cursor, in a deck. */
  slide: 0,
  /** Bumped (debounced) when the document changes. */
  docSeq: 0,
  /** Bumped when the sidebar should list its folder again (Show hidden files changed). */
  libraryVersion: 0,
  /** The sidebar file being renamed in place. */
  renaming: null as string | null,
  /** The sidebar's orders, from the settings (chrome/library.ts `SortType`). */
  librarySort: { listSort: 0, treeSort: 0, listNoGroup: false, treeNoGroup: false } as LibrarySort,
  /** The sidebar's Search (chrome/librarySearch.ts). */
  fileSearch: {
    /** The search box is showing (`ty-show-search`). */
    shown: false,
    /** The search box's text. */
    input: "",
    /** The search that ran, if any (`ty-on-search`). */
    query: null as string | null,
    results: null as FileSearchResults | null,
    options: { caseSensitive: false, wholeWord: false, regexp: false },
    /** The result last opened: a file, or a line in it. */
    active: null as { path: string; line: number | null } | null,
    /** Bumped to focus the search box. */
    focus: 0,
  },
  /** The Outline tab's filter, which uses the sidebar's search box. */
  outlineFilter: { shown: false, text: "" },
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

export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + (text.replace(CJK, " ").match(WORD)?.length ?? 0);
}

/** Counts of `text`, and of `selection` in it. */
export function countText(text: string, selection = ""): Counts {
  return {
    words: countWords(text),
    chars: text.replace(/\s/g, "").length,
    lines: text ? text.split("\n").length : 0,
    selWords: countWords(selection),
    selChars: selection.length,
  };
}

export function docText(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, "\n", " ");
}
