// The Preferences window, with the markup of Typora's macOS Preferences page. Only
// options Marpora implements are listed; categories without any are left out.

import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type { Settings } from "../ipc";
import type { PrefsApi, ThemeInfo } from "./api";

type Item =
  | {
      kind: "check";
      label: string;
      checked(s: Settings): boolean;
      change(on: boolean): void;
    }
  | {
      kind: "select";
      label: string;
      options(): [value: string, label: string][];
      value(s: Settings): string;
      change(value: string): void;
    }
  | { kind: "buttons"; buttons: { label: string; run(): void }[]; spaced?: boolean };

interface Group {
  title: string;
  hint?: string;
  items: Item[];
}

interface Panel {
  name: string;
  icon: () => JSX.Element;
  /** Shown above the groups, like Typora's "(applied after restart)" notes. */
  note?: string;
  groups: Group[];
}

/** Typora's search: a case-insensitive substring of the label. */
const matches = (query: string, text: string) => query !== "" && text.toLowerCase().includes(query.toLowerCase());

const itemTexts = (item: Item) =>
  item.kind === "buttons" ? item.buttons.map((b) => b.label) : item.kind === "select" ? [item.label, ...item.options().map((o) => o[1])] : [item.label];

export function Preferences(props: { api: PrefsApi; settings: Settings; themes: ThemeInfo[] }) {
  const [settings, setSettings] = createSignal(props.settings);
  const [themes, setThemes] = createSignal(props.themes);
  const [active, setActive] = createSignal(0);
  const [query, setQuery] = createSignal("");
  let search!: HTMLInputElement;

  props.api.onSettings((s) => {
    setSettings(s);
    // A theme added to the folder shows up in the menu after a change; catch up here too.
    void props.api.themes().then(setThemes);
  });
  const update = (patch: Partial<Settings>) => void props.api.update(patch).then(setSettings);
  const check = (label: string, key: keyof Settings): Item => ({
    kind: "check",
    label,
    checked: (s) => s[key] as boolean,
    change: (on) => update({ [key]: on }),
  });
  const flavor = (label: string, key: keyof Settings["flavor"]): Item => ({
    kind: "check",
    label,
    checked: (s) => s.flavor[key],
    change: (on) => update({ flavor: { ...settings().flavor, [key]: on } }),
  });

  const panels: Panel[] = [
    {
      name: "Files",
      icon: FilesIcon,
      groups: [
        {
          title: "Save & Recover",
          items: [
            check("Auto Save", "autoSave"),
            { kind: "buttons", buttons: [{ label: "Recover Unsaved Drafts", run: () => void props.api.openDraftsFolder() }] },
          ],
        },
        {
          title: "Recent Locations",
          items: [
            check("Record recent files and folders", "recordRecent"),
            { kind: "buttons", buttons: [{ label: "Clear Recent Folders and Files", run: () => void props.api.clearRecent() }] },
          ],
        },
        {
          title: "File Tree / Library",
          hint: "Choose which files appear in the file tree and file library.",
          items: [check("Show hidden folders / files", "showHiddenFiles")],
        },
      ],
    },
    {
      name: "Image",
      icon: ImageIcon,
      groups: [
        {
          title: "When Insert…",
          items: [
            {
              kind: "select",
              label: "When Insert…",
              options: () => {
                const options: [string, string][] = [
                  ["", "No special action"],
                  ["folder", "Copy image to current folder (./)"],
                  ["assets", "Copy image to ./assets"],
                  ["per-file-assets", "Copy image to ./${filename}.assets"],
                ];
                // A folder of the user's own, set in settings.json, stays listed.
                const custom = settings().imageStorage;
                if (!options.some(([v]) => v === custom)) options.push([custom, `Copy image to ${custom}`]);
                return options;
              },
              value: (s) => s.imageStorage,
              change: (v) => update({ imageStorage: v }),
            },
          ],
        },
        { title: "Preferred Image Syntax", items: [check("Use relative path if possible", "useRelativeImagePath")] },
      ],
    },
    {
      name: "Markdown",
      icon: MarkdownIcon,
      note: "(Following preferences will be applied after restart.)",
      groups: [
        {
          title: "Syntax Support",
          items: [
            flavor("Inline Math  (e.g: $\\LaTeX$)", "inlineMath"),
            flavor("Subscript    (e.g: H~2~O)", "subscript"),
            flavor("Superscript (e.g: X^2^)", "superscript"),
            flavor("Highlight     (e.g: ==key==)", "highlight"),
          ],
        },
        {
          title: "Math",
          items: [
            {
              kind: "select",
              label: "Auto Numbering Math Equations",
              options: () => [
                ["false", "No Automatic Equation Numbering"],
                ["true", "Auto Numbering for All Math Equations"],
              ],
              value: (s) => String(s.autoNumberMath),
              change: (v) => update({ autoNumberMath: v === "true" }),
            },
          ],
        },
      ],
    },
    {
      name: "Appearance",
      icon: AppearanceIcon,
      groups: [
        {
          title: "Themes",
          items: [
            {
              kind: "select",
              label: "Theme",
              options: () => themes().map((t) => [t.id, t.name]),
              value: (s) => s.theme,
              change: (id) => void props.api.setTheme(id),
            },
            {
              kind: "buttons",
              // Typora sets this gap below the theme menu.
              spaced: true,
              buttons: [{ label: "Open Theme Folder", run: () => void props.api.openThemeFolder() }],
            },
          ],
        },
      ],
    },
    {
      name: "General",
      icon: GeneralIcon,
      groups: [{ title: "Quit", items: [check("Quit Marpora when last window is closed", "quitOnLastWindowClosed")] }],
    },
  ];
  // `#image` opens that panel (Format › Image › Global Image Settings…).
  const showHash = () => {
    const i = panels.findIndex((p) => `#${p.name.toLowerCase()}` === location.hash);
    if (i >= 0) setActive(i);
  };
  showHash();
  window.addEventListener("hashchange", showHash);

  const groupHit = (g: Group) => matches(query(), g.title) || (g.hint !== undefined && matches(query(), g.hint));
  const itemHit = (item: Item) => itemTexts(item).some((t) => matches(query(), t));
  const panelHit = (p: Panel) => p.groups.some((g) => groupHit(g) || g.items.some(itemHit));
  const searching = () => query() !== "";
  const nothingFound = () => searching() && !panels.some(panelHit);

  const renderItem = (item: Item) => (
    <Switch>
      <Match when={item.kind === "check" && item}>
        {(it) => (
          <div class="checkbox row" classList={{ "search-hit": itemHit(it()) }}>
            <label>
              <input
                type="checkbox"
                checked={it().checked(settings())}
                onChange={(e) => it().change(e.currentTarget.checked)}
              />
              {it().label}
            </label>
            {" "}
          </div>
        )}
      </Match>
      <Match when={item.kind === "select" && item}>
        {(it) => (
          <table class="label-input-group">
            <tbody>
              <tr classList={{ "search-hit": itemHit(it()) }}>
                <td>
                  <span>{it().label}</span>
                </td>
                <td>
                  <div class="row">
                    <select value={it().value(settings())} onChange={(e) => it().change(e.currentTarget.value)}>
                      <For each={it().options()}>
                        {([value, label]) => (
                          <option value={value} selected={value === it().value(settings())}>
                            {label}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Match>
      <Match when={item.kind === "buttons" && item}>
        {(it) => (
          <div
            class="row"
            classList={{ "search-hit": itemHit(it()) }}
            style={it().spaced ? { "margin-top": "6px" } : undefined}
          >
            <For each={it().buttons}>
              {(b) => (
                <button aria-label={b.label} class="btn btn-default" onClick={() => b.run()}>
                  {b.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Match>
    </Switch>
  );

  return (
    <div class="window">
      <div class="window-content">
        <div class="pane-group" classList={{ "on-performance-search": searching() }}>
          <div class="pane-sm sidebar">
            <ul class="list-group">
              <li class="list-group-header">
                <div classList={{ "show-clear-icon": searching() }}>
                  <input
                    ref={search}
                    class="search-input"
                    type="search"
                    placeholder="Search for…"
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value.trim())}
                  />
                  <span
                    class="clear-btn-icon"
                    onClick={() => {
                      search.value = "";
                      setQuery("");
                    }}
                  >
                    <ClearIcon />
                  </span>
                </div>
              </li>
              <li class="list-group-content">
                <For each={panels}>
                  {(p, i) => (
                    <span
                      class="nav-group-item"
                      classList={{ active: active() === i(), "no-search-hit": searching() && !panelHit(p) }}
                      data-index={i()}
                      onClick={() => setActive(i())}
                    >
                      <span class="icon">{p.icon()}</span>
                      {p.name}
                    </span>
                  )}
                </For>
              </li>
            </ul>
          </div>
          <div class="pane">
            <div class="content no-results" classList={{ "display-none": !nothingFound() }}>
              <div>No results found for "{query()}"</div>
            </div>
            <For each={panels}>
              {(p, i) => (
                <div class="content" classList={{ "display-none": nothingFound() || active() !== i() }} data-index={i()}>
                  <Show when={p.note}>
                    <div class="panel-content-hint row" style={{ "margin-left": "0px" }}>
                      {p.note}
                    </div>
                  </Show>
                  <For each={p.groups}>
                    {(g) => (
                      <div class="input-group" classList={{ "search-hit": groupHit(g) }}>
                        <h5 class="input-group-header">
                          <span class="input-group-header-title">{g.title}</span>
                          <Show when={g.hint}>
                            <span class="input-group-header-hint">{g.hint}</span>
                          </Show>
                        </h5>
                        <div class="input-group-content">
                          <For each={g.items}>{renderItem}</For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}

// Icons drawn for Marpora, sized for Typora's 19×18 slots.

function FilesIcon() {
  return (
    <svg viewBox="0 0 19 18">
      <path d="M5 1h6l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm5.5 1v3.5H14zM6.5 9v1.3h6V9zm0 3v1.3h6V12zm0-6v1.3H9V6z" fill-rule="evenodd" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 19 18">
      <path d="M2.5 3h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm.5 1.5v7.7L6.6 8.6 9.4 11.4 12.4 8.4 16 12V4.5zM12 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill-rule="evenodd" />
    </svg>
  );
}

function MarkdownIcon() {
  return (
    <svg viewBox="0 0 19 18">
      <path
        d="M2.5 3h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 12h1.8V8.6L7.3 10.4 8.8 8.6V12h1.8V6H8.8L7.3 7.9 5.8 6H4zm9.2-6v3h-1.6l2.5 3 2.5-3H15V6z"
        fill-rule="evenodd"
      />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg viewBox="0 0 19 18">
      <path d="M8.2 1.5 15 8.3a1 1 0 0 1 0 1.4l-5.3 5.3a1 1 0 0 1-1.4 0L3 9.7a1 1 0 0 1 0-1.4l4.4-4.4-1.6-1.6zm1 3.5L5 9.2h8.4zM16 11.5s1.6 1.8 1.6 2.8a1.6 1.6 0 0 1-3.2 0c0-1 1.6-2.8 1.6-2.8z" />
    </svg>
  );
}

function GeneralIcon() {
  return (
    <svg viewBox="0 0 19 18">
      <circle cx="5.5" cy="5" r="3.4" />
      <circle cx="13.5" cy="5" r="3.4" />
      <circle cx="5.5" cy="13" r="3.4" />
      <circle cx="13.5" cy="13" r="3.4" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 12 12">
      <path d="M6 0a6 6 0 1 1 0 12A6 6 0 0 1 6 0zM3.9 3 3 3.9 5.1 6 3 8.1l.9.9L6 6.9 8.1 9l.9-.9L6.9 6 9 3.9 8.1 3 6 5.1z" />
    </svg>
  );
}
