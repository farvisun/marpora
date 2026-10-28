// Quick Open (⇧⌘O) with Typora's markup: recent files and the files in the document's
// folder, filtered by name as you type. Ranking is in library.ts.

import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { Backend, LibraryInfo } from "../ipc";
import { basename, highlight, type QuickItem, quickPath, rankQuick } from "./library";
import { setUi, ui } from "./store";

/** Recent files shown before anything is typed (Typora shows 12). */
const RECENT_SHOWN = 12;
/** File results shown at most. */
const MAX_RESULTS = 100;

export function QuickOpen(props: { backend: Backend; onOpenFile(path: string): void }) {
  let input!: HTMLInputElement;
  let listEl!: HTMLDivElement;
  const [query, setQuery] = createSignal("");
  const [recent, setRecent] = createSignal<QuickItem[]>([]);
  const [files, setFiles] = createSignal<QuickItem[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [info, setInfo] = createSignal<LibraryInfo>({ folder: null, openedFolder: false, home: null });
  const [active, setActive] = createSignal(0);

  createEffect(
    on(
      () => ui.quickOpen,
      (open) => {
        if (!open) return;
        input.select();
        input.focus();
        setActive(0);
        setSearching(true);
        void Promise.all([props.backend.libraryInfo(), props.backend.recentFiles(), props.backend.listDocuments(false)])
          .then(([info, recent, docs]) => {
            setInfo(info);
            // Recent files keep their order when nothing is typed.
            setRecent(recent.map((path, i) => ({ name: basename(path), path, modified: -i })));
            setFiles(docs.files.map((f) => ({ name: f.name, path: f.path, modified: f.modified })));
          })
          .finally(() => setSearching(false));
      },
    ),
  );

  // The open document is never offered, and a file is listed once.
  const sections = () => {
    const { folder, home } = info();
    const seen = new Set(ui.path ? [ui.path] : []);
    const pick = (items: QuickItem[], max: number) => {
      const out = rankQuick(
        items.filter((i) => !seen.has(i.path)),
        query(),
        folder,
        home,
      ).slice(0, max);
      for (const i of out) seen.add(i.path);
      return out;
    };
    const recentItems = pick(recent(), query().trim() ? MAX_RESULTS : RECENT_SHOWN);
    return { recent: recentItems, files: pick(files(), MAX_RESULTS) };
  };
  const all = () => [...sections().recent, ...sections().files];
  createEffect(on(query, () => setActive(0)));

  const close = () => setUi("quickOpen", false);
  const open = (path: string) => {
    close();
    props.onOpenFile(path);
  };
  const move = (by: number) => {
    const n = all().length;
    if (!n) return;
    const next = (active() + by + n) % n;
    setActive(next);
    listEl.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const keydown = (e: KeyboardEvent) => {
    const key = e.key;
    if (key === "Escape" || (key.toLowerCase() === "o" && e.shiftKey && e.metaKey)) close();
    else if (key === "ArrowUp" || (e.ctrlKey && !e.metaKey && key === "p")) move(-1);
    else if (key === "ArrowDown" || (e.ctrlKey && !e.metaKey && key === "n")) move(1);
    else if (key === "Enter") {
      const item = all()[active()];
      if (item) open(item.path);
    } else if (key !== "Tab") {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const item = (it: QuickItem, index: () => number) => (
    <div
      class="typora-quick-open-item"
      classList={{ active: index() === active() }}
      data-path={it.path}
      data-is-dir="false"
      data-index={index()}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        open(it.path);
      }}
    >
      <div class="typora-quick-open-item-title">
        <Marked text={it.name} query={query()} />
      </div>
      <div class="typora-quick-open-item-path">
        <Marked text={quickPath(it.path, info().folder, info().home)} query={query()} />
      </div>
    </div>
  );

  return (
    <div id="typora-quick-open" class="modal-dialog" style={{ display: ui.quickOpen ? "block" : "none" }}>
      <div id="typora-quick-open-input">
        <input
          ref={input}
          type="text"
          class="input"
          tabindex="1"
          autocorrect="off"
          spellcheck={false}
          autocapitalize="off"
          placeholder="Search by file name"
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={keydown}
          onBlur={() => setTimeout(close, 200)}
        />
      </div>
      <div class="typora-quick-open-list" id="typora-quick-open-list" ref={listEl}>
        <div
          class="ty-quick-open-category"
          id="ty-quick-open-recent-category"
          style={{ display: sections().recent.length ? "block" : "none" }}
        >
          <div class="ty-quick-open-category-title">Recent Files</div>
          <div id="ty-quick-open-recent-list-inner" class="ty-quick-open-category-list-inner">
            <For each={sections().recent}>{(it, i) => item(it, i)}</For>
          </div>
        </div>
        <div
          class="ty-quick-open-category"
          id="ty-quick-open-infolder-category"
          classList={{ "ty-has-prev": sections().recent.length > 0 }}
          style={{ display: sections().files.length || searching() ? "block" : "none" }}
        >
          <div class="ty-quick-open-category-title">File Results</div>
          <div class="typora-quick-open-list-inner">
            <For each={sections().files}>{(it, i) => item(it, () => sections().recent.length + i())}</For>
            <Show when={searching()}>
              <div class="typora-quick-open-info-item">
                <div class="typora-quick-open-info">Searching</div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

/** `text` with the query's matches in bold, as Typora shows them. */
function Marked(props: { text: string; query: string }) {
  return (
    <For each={highlight(props.text, props.query)}>{([part, hit]) => (hit ? <b>{part}</b> : part)}</For>
  );
}
