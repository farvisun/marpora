// The find and replace panel, with Typora's markup (#md-searchpanel and its ids) so
// themes that style it apply. The logic lives in search.ts.

import { createEffect, type JSX, onCleanup, Show } from "solid-js";
import type { Search, SearchOptions } from "./search";
import { ui } from "./store";

export function SearchPanel(props: { search: Search }) {
  const search = props.search;
  let input!: HTMLInputElement;
  let replaceInput!: HTMLInputElement;

  let panel!: HTMLDivElement;
  // Escape closes the panel from its buttons too, which leave the focus on the page.
  const escape = (e: KeyboardEvent) => {
    const at = document.activeElement;
    if (e.key !== "Escape" || !ui.search.open || (at && at !== document.body && !panel.contains(at))) return;
    e.preventDefault();
    search.close();
  };
  document.addEventListener("keydown", escape);
  onCleanup(() => document.removeEventListener("keydown", escape));

  createEffect(() => {
    if (!ui.search.focus || !ui.search.open) return;
    input.value = search.query;
    input.focus();
    input.select();
  });

  const keydown = (e: KeyboardEvent, onEnter: (shift: boolean) => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter(e.shiftKey);
    }
  };

  const option = (name: keyof SearchOptions, id: string, hint: string, icon: () => JSX.Element) => (
    <span
      ty-hint={hint}
      id={id}
      class="searchpanel-search-option-btn"
      classList={{ active: ui.search.options[name] }}
      aria-label={hint}
      onMouseDown={(e) => {
        e.preventDefault();
        search.setOption(name, !ui.search.options[name]);
      }}
    >
      {icon()}
    </span>
  );

  return (
    <div
      ref={panel}
      id="md-searchpanel"
      class="form-inline"
      classList={{
        "searchpanel-replace-mode": ui.search.replace,
        "searchpanel-msg-mode": ui.search.replace && ui.search.message !== null,
      }}
      style={{ display: ui.search.open ? "block" : "none" }}
    >
      <div id="searchpanel-search-group">
        <div style={{ "text-align": "right" }}>
          <div class="ty-search-panel-row">
            <span
              class="input-group-addon search-type-selection btn"
              id="md-search-type-label"
              onClick={() => search.setMode(true)}
            >
              <label>
                <span>Search</span>&nbsp;
              </label>
              <Caret down />
            </span>
          </div>
          <div class="ty-search-panel-row ty-replace-panel-row">
            <span class="input-group-addon search-type-selection btn" id="md-replace-type-label" onClick={() => search.setMode(false)}>
              <label>
                <span>Replace</span>&nbsp;
              </label>
              <Caret />
            </span>
          </div>
        </div>

        <div style={{ flex: "1" }}>
          <div class="ty-search-panel-row">
            <input
              ref={input}
              type="text"
              class="form-control"
              placeholder="search text"
              autocorrect="off"
              spellcheck={false}
              autocapitalize="off"
              id="search-panel-input"
              role="searchbox"
              onInput={(e) => search.setQuery(e.currentTarget.value)}
              onKeyDown={(e) => keydown(e, (shift) => search.step(shift ? -1 : 1))}
            />
            {option("regexp", "searchpanel-regexp-option-btn", "Regular Expression", RegexpIcon)}
            {option("caseSensitive", "searchpanel-case-option-btn", "Case Sensitive", CaseIcon)}
            {option("wholeWord", "searchpanel-word-option-btn", "Whole Word", WordIcon)}
          </div>
          <div class="ty-search-panel-row ty-replace-panel-row">
            <input
              ref={replaceInput}
              type="text"
              class="form-control"
              placeholder="replace with"
              autocorrect="off"
              spellcheck={false}
              autocapitalize="off"
              id="search-panel-replace-input"
              onInput={(e) => (search.replacement = e.currentTarget.value)}
              onKeyDown={(e) => keydown(e, () => search.replace())}
            />
          </div>
        </div>

        <div style={{ flex: "0" }}>
          <div class="ty-search-panel-row">
            <span class="input-group-addon btn" id="search-panel-prev" onClick={() => search.step(-1)}>
              <Chevron up />
            </span>
            <span class="input-group-addon btn" id="search-panel-next" onClick={() => search.step(1)}>
              <Chevron />
            </span>
            <span class="input-group-addon" id="search-panel-status">
              <Show when={ui.search.error} fallback={ui.search.status}>
                <span class="error-message">{ui.search.status}</span>
              </Show>
            </span>
            <span class="input-group-addon btn close-btn" onClick={() => search.close()}>
              <span class="ion-close-round">
                <CloseIcon />
              </span>
            </span>
          </div>
          <div class="ty-search-panel-row ty-replace-panel-row">
            <span class="input-group-addon btn" id="search-panel-replaceall-btn" onClick={() => search.replaceAll()}>
              <span>All</span>
            </span>
            <span class="input-group-addon btn" id="search-panel-replace-btn" onClick={() => search.replace()}>
              <span>Replace</span>
            </span>
            <span class="input-group-addon" />
          </div>
        </div>
      </div>

      <div class="input-group input-group-sm" id="searchpanel-msg">
        <div class="alert alert-warning" role="alert">
          <span class="searchpanel-msg-icon">
            <CheckIcon />
          </span>
          <span id="searchpanel-msg-content">{ui.search.message}</span>
          <span id="searchpanel-msg-close-btn" class="searchpanel-msg-btn" onClick={() => search.dismissMessage()}>
            Dismiss
          </span>
          <span id="searchpanel-msg-undo-btn" class="searchpanel-msg-btn" onClick={() => search.undo()}>
            Undo
          </span>
        </div>
      </div>
    </div>
  );
}

// Icons drawn for Marpora, sized like Typora's.

function Caret(props: { down?: boolean }) {
  return (
    <svg class="search-caret" width="7" height="12" viewBox="0 0 7 12" fill="currentColor">
      <path d={props.down ? "M0 5h7L3.5 9z" : "M0 8h7L3.5 4z"} />
    </svg>
  );
}

function Chevron(props: { up?: boolean }) {
  return (
    <svg class="search-chevron" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.8">
      <path d={props.up ? "M1.5 7.5 5.5 3.5l4 4" : "M1.5 3.5l4 4 4-4"} />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" stroke="currentColor" stroke-width="1.8">
      <path d="M1 1l7 7M8 1 1 8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" stroke-width="2">
      <path d="m1 5 3.5 3.5L11 1.5" />
    </svg>
  );
}

function TextIcon(props: { text: string; underline?: boolean }) {
  return (
    <svg class="icon" viewBox="0 0 20 14">
      <text x="10" y="11" text-anchor="middle" font-size="11" font-weight="600" font-family="-apple-system, sans-serif">
        {props.text}
      </text>
      <Show when={props.underline}>
        <path d="M3 12.5h14M3 10v2.5M17 10v2.5" stroke="currentColor" stroke-width="1.2" fill="none" />
      </Show>
    </svg>
  );
}

export const CaseIcon = () => <TextIcon text="Aa" />;
export const WordIcon = () => <TextIcon text="ab" underline />;
export const RegexpIcon = () => <TextIcon text="(.*)" />;
