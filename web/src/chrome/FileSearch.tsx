// The sidebar's Search with Typora's macOS markup: the search box in place of the tab
// bar (`#ty-sidebar-search-tabs`) and the results in place of the files
// (`#file-library-search-result`), one `.ty-search-item` per file with its matching
// lines. The logic is in librarySearch.ts.

import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { Backend, FileHit } from "../ipc";
import { hideFileSearch, runFileSearch } from "./librarySearch";
import { splitName } from "./library";
import { buildPattern } from "./search";
import { CaseIcon, RegexpIcon, WordIcon } from "./SearchPanel";
import { setUi, ui } from "./store";

/** Lines shown before "show N more matches", as in Typora. */
const SHOWN_LINES = 5;
/** Files with more matches than this start expanded, while few lines are listed. */
const EXPAND_OVER = 6;
const EXPAND_LIMIT = 30;

/** A result line in parts, matches marked. The text before the first match is cut to
 * its last 20 characters, as Typora does, so the match shows in the narrow sidebar. */
export function lineParts(text: string, ranges: [number, number][]): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at), match: false });
  const lead = parts[0];
  if (ranges.length && !lead.match) {
    lead.text = lead.text.replace(/^\s+/, "");
    if (lead.text.length > 20) {
      const tail = lead.text.slice(-20);
      lead.text = `...${tail.replace(/^.+?\b/, "") || tail}`;
    }
  }
  return parts;
}

/** `text` in parts with the first match of `pattern` marked (for file names). */
function markFirst(text: string, pattern: RegExp | null): { text: string; match: boolean }[] {
  pattern = pattern && new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const m = pattern && text ? pattern.exec(text) : null;
  if (!m || !m[0]) return [{ text, match: false }];
  return [
    { text: text.slice(0, m.index), match: false },
    { text: m[0], match: true },
    { text: text.slice(m.index + m[0].length), match: false },
  ].filter((p) => p.text);
}

function Parts(props: { parts: { text: string; match: boolean }[]; wrap?: boolean }) {
  return (
    <For each={props.parts}>
      {(p) =>
        p.match ? (
          <span class="ty-file-search-match-text">{p.text}</span>
        ) : props.wrap ? (
          <span>{p.text}</span>
        ) : (
          p.text
        )
      }
    </For>
  );
}

/** The search box, shown instead of the tab bar. */
export function FileSearchTabs(props: { backend: Backend }) {
  let input!: HTMLInputElement;
  createEffect(
    on(
      () => ui.fileSearch.focus,
      () => {
        input.focus();
        input.select();
      },
      { defer: true },
    ),
  );
  const option = (key: "caseSensitive" | "wholeWord" | "regexp", setting: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const on = !ui.fileSearch.options[key];
    setUi("fileSearch", "options", key, on);
    void props.backend.updateSettings({ [setting]: on });
  };
  const keydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      hideFileSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = document.querySelector<HTMLElement>("#file-library-search-result .select");
      if (selected && ui.fileSearch.query === input.value.trim()) {
        selected.classList.remove("select");
        (selected.classList.contains("ty-search-item") ? selected.querySelector<HTMLElement>(".ty-search-item-summary") : selected)?.click();
      } else void runFileSearch(props.backend, input.value);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(e.key === "ArrowUp" ? -1 : 1);
    }
  };
  return (
    <div class="ty-sidebar-search-panel" id="ty-sidebar-search-tabs">
      <div class="sidebar-tab-btn" id="ty-sidebar-search-back-btn" onClick={hideFileSearch}>
        <span class="ty-icon ty-left-arrow" ty-hint="Close Search">
          <BackIcon />
        </span>
      </div>
      <input
        ref={input}
        type="search"
        id="file-library-search-input"
        placeholder="Search"
        aria-label="Search files"
        autocomplete="off"
        value={ui.fileSearch.input}
        onInput={(e) => setUi("fileSearch", "input", e.currentTarget.value)}
        onKeyDown={keydown}
        onFocus={() => document.querySelector("#file-library-search-result .select")?.classList.remove("select")}
      />
      <span
        ty-hint="Case Sensitive"
        id="filesearch-case-option-btn"
        class="searchpanel-search-option-btn"
        classList={{ select: ui.fileSearch.options.caseSensitive }}
        aria-label="Case Sensitive"
        onMouseDown={option("caseSensitive", "fileSearchCaseSensitive")}
      >
        <CaseIcon />
      </span>
      <span
        ty-hint="Whole Word"
        id="filesearch-word-option-btn"
        class="searchpanel-search-option-btn"
        classList={{ select: ui.fileSearch.options.wholeWord }}
        aria-label="Whole Word"
        onMouseDown={option("wholeWord", "fileSearchWholeWord")}
      >
        <WordIcon />
      </span>
      <span
        ty-hint="Regular Expression"
        id="filesearch-regexp-option-btn"
        class="searchpanel-search-option-btn"
        classList={{ select: ui.fileSearch.options.regexp }}
        aria-label="Regular Expression"
        onMouseDown={option("regexp", "fileSearchUseRegexp")}
      >
        <RegexpIcon />
      </span>
    </div>
  );
}

/** Up or down through the results (files and their visible lines), as Typora's keys do. */
function moveSelection(dir: 1 | -1) {
  const host = document.querySelector("#file-library-search-result");
  if (!host) return;
  const items = [...host.querySelectorAll<HTMLElement>(".ty-search-item, .ty-search-item-line")].filter(
    (el) => el.classList.contains("ty-search-item") || el.offsetParent !== null,
  );
  const current = host.querySelector<HTMLElement>(".select") ?? host.querySelector<HTMLElement>(".active");
  const next = current ? items[items.indexOf(current) + dir] : items[0];
  if (!next) return;
  current?.classList.remove("select");
  next.classList.add("select");
  next.scrollIntoView({ block: "nearest" });
}

/** The results, shown instead of the files. */
export function FileSearchResults(props: {
  folder: string | null;
  onOpenFile(path: string): void;
  onOpenMatch(path: string, line: number): void;
}) {
  const pattern = () =>
    ui.fileSearch.query && !ui.fileSearch.options.regexp ? buildPattern(ui.fileSearch.query, ui.fileSearch.options) : null;
  const lineCount = () => ui.fileSearch.results?.files.reduce((n, f) => n + f.lines.length, 0) ?? 0;
  return (
    <div id="file-library-search">
      <div id="file-library-search-result">
        <Show when={ui.fileSearch.results}>
          {(results) => (
            <>
              <For each={results().files}>
                {(hit) => (
                  <SearchItem
                    hit={hit}
                    folder={props.folder}
                    pattern={pattern()}
                    expanded={lineCount() <= EXPAND_LIMIT && hit.total > EXPAND_OVER}
                    onOpenFile={props.onOpenFile}
                    onOpenMatch={props.onOpenMatch}
                  />
                )}
              </For>
              <Show when={results().error ?? (results().files.length ? null : "No result found.")}>
                {(message) => <div class="ty-search-result-error-message">{message()}</div>}
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

function SearchItem(props: {
  hit: FileHit;
  folder: string | null;
  pattern: RegExp | null;
  expanded: boolean;
  onOpenFile(path: string): void;
  onOpenMatch(path: string, line: number): void;
}) {
  const hit = props.hit;
  const [fold, setFold] = createSignal<"" | "expand" | "collapse">(props.expanded ? "expand" : "");
  const slash = hit.path.lastIndexOf("/");
  const [name, ext] = splitName(hit.path.slice(slash + 1));
  const relative = props.folder && hit.path.startsWith(`${props.folder}/`) ? hit.path.slice(props.folder.length + 1) : hit.path;
  const dir = relative.slice(0, Math.max(0, relative.lastIndexOf("/")));
  const location = dir ? `${dir}/`.replace(/\//g, " / ") : "";
  const active = () => ui.fileSearch.active;
  const lines = hit.lines.slice(0, 21);
  const more = lines.length > EXPAND_OVER;
  return (
    <div
      class="ty-search-item"
      classList={{
        "ty-search-item-expand": fold() === "expand",
        "ty-search-item-collapse": fold() === "collapse",
        active: hit.path === ui.path && (active()?.line ?? null) === null,
      }}
      data-path={hit.path}
    >
      <div
        class="ty-search-item-summary"
        onClick={() => {
          setUi("fileSearch", "active", { path: hit.path, line: null });
          props.onOpenFile(hit.path);
        }}
      >
        <div
          class="ty-search-item-collapse-icon"
          onClick={(e) => {
            e.stopPropagation();
            setFold(fold() === "collapse" ? "expand" : "collapse");
          }}
        >
          <i class="fa fa-caret-right">
            <CaretRight />
          </i>
          <i class="fa fa-caret-down">
            <CaretDown />
          </i>
        </div>
        <div style={{ display: "flex" }}>
          <div class="file-list-item-file-name">
            <span class="file-list-item-file-name-part">
              <Parts parts={markFirst(name, props.pattern)} />
            </span>
            <span class="file-list-item-file-ext-part">
              <Parts parts={markFirst(ext, props.pattern)} />
            </span>
          </div>
          <div class="file-list-item-right">
            <span class="file-list-item-count">{hit.total > 20 ? "20+" : hit.total}</span>
          </div>
        </div>
        <div class="file-list-item-parent-loc">{location}</div>
      </div>
      <div class="ty-search-item-matches">
        <For each={lines}>
          {(line, i) => (
            <>
              <Show when={more && i() === SHOWN_LINES}>
                <div
                  class="ty-search-item-line ty-search-item-line-expand"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFold("expand");
                  }}
                >
                  show {lines.length - SHOWN_LINES} more matches
                </div>
              </Show>
              <div
                class="ty-search-item-line"
                classList={{
                  "ty-search-item-line-more": more && i() >= SHOWN_LINES,
                  active: active()?.path === hit.path && active()?.line === line.line,
                }}
                data-line={line.line}
                onClick={(e) => {
                  e.stopPropagation();
                  setUi("fileSearch", "active", { path: hit.path, line: line.line });
                  props.onOpenMatch(hit.path, line.line);
                }}
              >
                <Parts parts={lineParts(line.text, line.ranges)} wrap />
              </div>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

// Icons drawn for Marpora.

function BackIcon() {
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M15.5 6H1M6 1 1 6l5 5" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.7">
      <circle cx="6" cy="6" r="5" />
      <path d="m9.7 9.7 4.6 4.6" stroke-linecap="round" />
    </svg>
  );
}

function CaretRight() {
  return (
    <svg width="5" height="9" viewBox="0 0 5 9" fill="currentColor">
      <path d="M0 0l5 4.5L0 9z" />
    </svg>
  );
}

function CaretDown() {
  return (
    <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor">
      <path d="M0 0h9L4.5 5z" />
    </svg>
  );
}
