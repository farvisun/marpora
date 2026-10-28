// The find and replace panel's logic (the panel is SearchPanel.tsx). It searches the
// WYSIWYG editor or, in source mode, the CodeMirror source, through `SearchTarget`.

import { undo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import type { CodeMirrorEditor, CodeMirrorPos } from "../cm";
import {
  MAX_HITS,
  replaceAll,
  replaceCurrent,
  type SearchStatus,
  searchStatus,
  setSearch,
  stepSearch,
} from "../editor/search";
import { setUi, ui } from "./store";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

/** Typora's search expression; null when `text` is empty or not a valid regexp. */
export function buildPattern(text: string, o: SearchOptions): RegExp | null {
  if (!text) return null;
  const flags = o.caseSensitive ? "g" : "gi";
  if (o.regexp) {
    try {
      return new RegExp(o.wholeWord ? `\\b${text.replace(/^\\b|\\b$/g, "")}\\b` : text, flags);
    } catch {
      return null;
    }
  }
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(o.wholeWord ? `\\b${escaped}\\b` : escaped, flags);
}

export interface SearchTarget {
  /** Search for `pattern` (null clears) from where the search began. */
  find(pattern: RegExp | null): SearchStatus;
  step(dir: 1 | -1): SearchStatus;
  replace(text: string, regexp: boolean): SearchStatus;
  replaceAll(text: string, regexp: boolean): number;
  status(): SearchStatus;
  /** The selection, to search for when the panel opens. */
  selectedText(): string;
  focus(): void;
  undo(): void;
}

export function editorTarget(view: EditorView): SearchTarget {
  const start = view.state.selection.from;
  return {
    find(pattern) {
      setSearch(view, pattern, start);
      return searchStatus(view.state);
    },
    step(dir) {
      stepSearch(view, dir);
      return searchStatus(view.state);
    },
    replace(text, regexp) {
      replaceCurrent(view, text, regexp);
      return searchStatus(view.state);
    },
    replaceAll: (text, regexp) => replaceAll(view, text, regexp),
    status: () => searchStatus(view.state),
    selectedText() {
      const { from, to } = view.state.selection;
      return view.state.doc.textBetween(from, to, "\n");
    },
    focus: () => view.focus(),
    undo: () => undo(view.state, view.dispatch),
  };
}

/**
 * Search in the source editor, with CodeMirror marks (`cm-search-hit`) for matches.
 * Edits search again and call `onChange`.
 */
export function sourceTarget(cm: CodeMirrorEditor, onChange: () => void): SearchTarget {
  const start = cm.indexFromPos(cm.getCursor());
  let pattern: RegExp | null = null;
  let hits: [number, number][] = [];
  let current = -1;
  let marks: { clear(): void }[] = [];

  const pos = (i: number): CodeMirrorPos => cm.posFromIndex(i);
  const scan = (from: number) => {
    hits = [];
    if (pattern) {
      const text = cm.getValue();
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m && hits.length < MAX_HITS; m = pattern.exec(text)) {
        if (!m[0]) pattern.lastIndex++;
        else hits.push([m.index, m.index + m[0].length]);
      }
    }
    current = hits.length ? Math.max(0, hits.findIndex(([s]) => s >= from)) : -1;
    paint();
  };
  const paint = () =>
    cm.operation(() => {
      for (const m of marks) m.clear();
      marks = hits.map(([s, e], i) =>
        cm.markText(pos(s), pos(e), { className: i === current ? "cm-search-hit md-search-select" : "cm-search-hit" }),
      );
      if (current >= 0) {
        cm.setSelection(pos(hits[current][0]), pos(hits[current][1]));
        cm.scrollIntoView({ from: pos(hits[current][0]), to: pos(hits[current][1]) }, 100);
      }
    });
  const status = (): SearchStatus => ({ count: hits.length, current });
  const replacement = (text: string, s: number, e: number, regexp: boolean) =>
    regexp && pattern
      ? cm.getValue().slice(s, e).replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), text)
      : text;

  let replacing = false;
  const changed = () => {
    if (!pattern || replacing) return;
    scan(current >= 0 ? hits[current][0] : 0);
    onChange();
  };

  return {
    find(p) {
      if (p && !pattern) cm.on("changes", changed);
      if (!p && pattern) cm.off("changes", changed);
      pattern = p;
      scan(start);
      return status();
    },
    step(dir) {
      if (hits.length) {
        current = (current + dir + hits.length) % hits.length;
        paint();
      }
      return status();
    },
    replace(text, regexp) {
      if (current < 0) return status();
      const [s, e] = hits[current];
      const rep = replacement(text, s, e, regexp);
      replacing = true;
      cm.replaceRange(rep, pos(s), pos(e), "+findReplace");
      replacing = false;
      scan(s + rep.length);
      return status();
    },
    replaceAll(text, regexp) {
      const count = hits.length;
      replacing = true;
      cm.operation(() => {
        for (let i = hits.length - 1; i >= 0; i--) {
          const [s, e] = hits[i];
          cm.replaceRange(replacement(text, s, e, regexp), pos(s), pos(e), "+findReplace");
        }
      });
      replacing = false;
      scan(0);
      return count;
    },
    status,
    selectedText: () => cm.getSelection(),
    focus: () => cm.focus(),
    undo: () => cm.undo(),
  };
}

/** The panel's controller: one per window. */
export class Search {
  private target: SearchTarget | null = null;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;
  options: SearchOptions = { caseSensitive: false, wholeWord: false, regexp: false };
  query = "";
  replacement = "";

  constructor(private makeTarget: () => SearchTarget) {}

  /** Show the panel (⌘F, or ⌥⌘F with `replace`), searching for the selection if any. */
  open(replace: boolean) {
    this.target = this.makeTarget();
    const selected = this.target.selectedText();
    if (selected && !selected.includes("\n")) this.query = selected;
    setUi("search", { open: true, replace, message: null, focus: ui.search.focus + 1 });
    this.run();
  }

  /** Switch between find and find-and-replace without searching again. */
  setMode(replace: boolean) {
    setUi("search", { replace, message: null, focus: ui.search.focus + 1 });
  }

  close() {
    if (!ui.search.open) return;
    this.target?.find(null);
    this.target?.focus();
    this.target = null;
    setUi("search", { open: false, replace: false, message: null, status: "", error: false });
  }

  setQuery(text: string) {
    this.query = text;
    this.run();
  }

  setOption(name: keyof SearchOptions, on: boolean) {
    this.options = { ...this.options, [name]: on };
    setUi("search", "options", { ...this.options });
    this.run();
  }

  /** Next (1) or previous (-1) match; opens the panel if it is closed (⌘G). */
  step(dir: 1 | -1) {
    if (!ui.search.open || !this.target) {
      if (!this.query) return this.open(false);
      this.open(ui.search.replace);
    }
    this.show(this.target!.step(dir));
  }

  replace() {
    if (this.target) this.show(this.target.replace(this.replacement, this.options.regexp));
  }

  replaceAll() {
    if (!this.target) return;
    const n = this.target.replaceAll(this.replacement, this.options.regexp);
    if (!n) return;
    this.show(this.target.status());
    this.message(`Replaced ${n} occurrence(s)`);
  }

  /** Undo the last Replace All (the message's Undo button). */
  undo() {
    this.target?.undo();
    setUi("search", "message", null);
    this.run();
  }

  dismissMessage() {
    setUi("search", "message", null);
  }

  /** The document changed under the panel: update the count. */
  refresh() {
    if (ui.search.open && this.target) this.show(this.target.status());
  }

  /** The editor was swapped (source mode toggled): search the new one. */
  retarget() {
    if (!ui.search.open) return;
    this.target = this.makeTarget();
    this.run();
  }

  private run() {
    if (!this.target) return;
    const pattern = buildPattern(this.query, this.options);
    this.show(this.target.find(pattern));
  }

  private show({ count, current }: SearchStatus) {
    if (!this.query) setUi("search", { status: "", error: false });
    else if (count >= MAX_HITS) setUi("search", { status: "5000+", error: true });
    else if (count) setUi("search", { status: `${current + 1} / ${count}`, error: false });
    else setUi("search", { status: "No Results", error: true });
  }

  private message(text: string) {
    if (this.messageTimer) clearTimeout(this.messageTimer);
    setUi("search", "message", text);
    this.messageTimer = setTimeout(() => setUi("search", "message", null), 5000);
  }
}
