// Window chrome around the editor, using Typora's element ids and classes so themes
// that style the sidebar and footer apply.

import { createEffect, For, Show } from "solid-js";
import type { Search } from "./search";
import { SearchPanel } from "./SearchPanel";
import { setUi, ui } from "./store";

export interface ChromeProps {
  onOutlineClick(pos: number): void;
  onToggleSource(): void;
  mountEditor(el: HTMLElement): void;
  mountSource(el: HTMLElement): void;
  search: Search;
}

export function App(props: ChromeProps) {
  createEffect(() => {
    document.body.classList.toggle("on-search-panel-open", ui.search.open);
    document.body.classList.toggle("on-replace-panel-open", ui.search.open && ui.search.replace);
  });
  return (
    <>
      <SearchPanel search={props.search} />
      <Show when={ui.sidebar}>
        <div id="typora-sidebar" class="sidebar">
          <div class="sidebar-tabs">
            <div
              class="sidebar-tab"
              classList={{ active: ui.sidebarTab === "outline" }}
              onClick={() => setUi("sidebarTab", "outline")}
            >
              Outline
            </div>
          </div>
          <div id="outline-content" class="sidebar-content outline-content">
            <For each={ui.outline}>
              {(item, i) => (
                <div class={`outline-item-wrapper outline-h${item.level}`}>
                  <div
                    class="outline-item"
                    classList={{ "outline-item-active": i() === ui.activeHeading }}
                    style={{ "padding-left": `${(item.level - 1) * 16 + 12}px` }}
                    onClick={() => props.onOutlineClick(item.pos)}
                  >
                    <span class="outline-label">{item.text || " "}</span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
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
