// Window chrome around the editor, using Typora's element ids and classes so themes
// that style the sidebar and footer apply.

import { createEffect } from "solid-js";
import type { Backend } from "../ipc";
import { QuickOpen } from "./QuickOpen";
import type { Search } from "./search";
import { SearchPanel } from "./SearchPanel";
import { Sidebar } from "./Sidebar";
import { setUi, ui } from "./store";

export interface ChromeProps {
  backend: Backend;
  onOutlineClick(pos: number): void;
  /** Open a file picked in the sidebar or Quick Open. */
  onOpenFile(path: string): void;
  /** Open a sidebar search result's file at zero-based source line `line`. */
  onOpenMatch(path: string, line: number): void;
  /** The editor's selection. */
  selectedText(): string;
  onToggleSource(): void;
  mountEditor(el: HTMLElement): void;
  mountSource(el: HTMLElement): void;
  search: Search;
}

export function App(props: ChromeProps) {
  createEffect(() => {
    document.body.classList.toggle("on-search-panel-open", ui.search.open);
    document.body.classList.toggle("on-replace-panel-open", ui.search.open && ui.search.replace);
    document.body.classList.toggle("pin-outline", ui.sidebar);
  });
  return (
    <>
      <SearchPanel search={props.search} />
      <Sidebar
        backend={props.backend}
        onOutlineClick={props.onOutlineClick}
        onOpenFile={props.onOpenFile}
        onOpenMatch={props.onOpenMatch}
        selectedText={props.selectedText}
      />
      <QuickOpen backend={props.backend} onOpenFile={props.onOpenFile} />
      <content>
        <div ref={(el) => props.mountEditor(el)} />
        <div id="typora-source" ref={(el) => props.mountSource(el)} />
      </content>
      <footer class="ty-footer" id="footer">
        <button
          class="footer-item footer-btn"
          id="sidebar-btn"
          title="Toggle Sidebar (⇧⌘L)"
          onClick={() => setUi("sidebar", !ui.sidebar)}
        >
          <SidebarIcon />
        </button>
        <button
          class="footer-item footer-btn"
          id="toggle-sourceview-btn"
          classList={{ active: ui.sourceMode }}
          title="Source Code Mode (⌘/)"
          onClick={() => props.onToggleSource()}
        >
          {"</>"}
        </button>
        <span class="footer-spacer" />
        <span id="footer-word-count" class="footer-item" title={`${ui.counts.chars} characters, ${ui.counts.lines} lines`}>
          {ui.counts.words} {ui.counts.words === 1 ? "word" : "words"}
        </span>
      </footer>
    </>
  );
}

function SidebarIcon() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.2">
      <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1.5" />
      <line x1="5" y1="0.6" x2="5" y2="11.4" />
    </svg>
  );
}
