// The sidebar's Search (View › Search, ⇧⌘F): find in the library folder's files, as
// Typora does with ripgrep. The box replaces the sidebar's tab bar; Enter searches and
// the results replace the file list. Opening a file reloads the window, so the search
// is kept in the session and run again when the window comes back.

import type { Backend, Settings } from "../ipc";
import { setUi, ui } from "./store";

const KEY = "marpora.fileSearch";

/** Bring back the search a reload interrupted. */
export function restoreFileSearch(backend: Backend) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (!saved?.shown) return;
    setUi("fileSearch", { shown: true, input: saved.input ?? "", active: saved.active ?? null });
    if (saved.query) void runFileSearch(backend, saved.query);
  } catch {
    // Nothing kept.
  }
}

export function saveFileSearch() {
  try {
    const { shown, input, query, active } = ui.fileSearch;
    sessionStorage.setItem(KEY, JSON.stringify({ shown, input, query, active }));
  } catch {
    // Not kept across a reload.
  }
}

export function fileSearchOptionsOf(s: Settings) {
  return { caseSensitive: s.fileSearchCaseSensitive, wholeWord: s.fileSearchWholeWord, regexp: s.fileSearchUseRegexp };
}

/** Show the search box on the Files tab, with `selected` (one line of the editor's
 * selection) in it. Shown already, it is focused. */
export function showFileSearch(selected = "") {
  setUi({ sidebar: true, sidebarTab: "files" });
  if (!ui.fileSearch.shown) {
    const input = selected.includes("\n") ? "" : selected.trim();
    setUi("fileSearch", { shown: true, input, query: null, results: null, active: null });
  }
  setUi("fileSearch", "focus", (n) => n + 1);
}

let onHide = () => {};

/** Run `fn` when the search closes (to clear the editor's match highlights). */
export function onFileSearchHidden(fn: () => void) {
  onHide = fn;
}

export function hideFileSearch() {
  setUi("fileSearch", { shown: false, query: null, results: null, active: null });
  onHide();
}

/** View › Search: hide a search that is showing results, else show the box. */
export function toggleFileSearch(selected: string) {
  if (ui.fileSearch.shown && ui.fileSearch.query !== null && ui.sidebar && ui.sidebarTab === "files") hideFileSearch();
  else showFileSearch(selected);
}

/** The Outline tab's search button: filter the headings. */
export function showOutlineFilter() {
  if (!ui.outlineFilter.shown) setUi("outlineFilter", { shown: true, text: "" });
  setUi("fileSearch", "focus", (n) => n + 1);
}

export function hideOutlineFilter() {
  setUi("outlineFilter", { shown: false, text: "" });
}

/** The filter's text as Typora matches it: a case-insensitive substring. */
export function outlineFilterPattern(): RegExp | null {
  const text = ui.outlineFilter.shown ? ui.outlineFilter.text : "";
  return text.trim() ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
}

let latest = 0;

/** Search for `text`; an empty text clears the results. */
export async function runFileSearch(backend: Backend, text: string) {
  const query = text.trim();
  const id = ++latest;
  setUi("fileSearch", { query: query || null, results: null });
  if (!query) return;
  const results = await backend.searchLibrary({ text: query, ...ui.fileSearch.options });
  if (id === latest) setUi("fileSearch", "results", results);
}
