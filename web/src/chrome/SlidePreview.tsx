// View › Slide Preview: a Marp deck's slides beside the editor, kept in step with the
// text. The slide holding the cursor is outlined and scrolled into view; a click on a
// slide puts the cursor at its start. The header's menu sets the deck's `theme:`, from
// Marp's themes and the user's Marp themes folder. Marp's markup and styles live in a
// shadow root, apart from the editor's theme.

import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { localCss, marpBrowser, renderDeck } from "../marp/marp";
import { report } from "../ipc";
import { setUi, ui } from "./store";

export interface SlidePreviewProps {
  /** The document's Markdown now, as it would be saved. */
  markdown(): Promise<string>;
  /** The URL that shows image `src` of the document. */
  assetUrl(src: string): string;
  /** Put the cursor at the start of slide `index`. */
  gotoSlide(index: number): void;
  /** Set the deck's `theme:`. */
  setTheme(name: string): void;
  /** Show the user's Marp themes folder. */
  openThemeFolder(): void;
}

/** Image references in Marp's output, made to load like the editor's images. */
function resolveImages(root: ParentNode, assetUrl: (src: string) => string) {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) img.src = assetUrl(img.getAttribute("src")!);
  for (const el of root.querySelectorAll<HTMLElement>("[style*='url(']")) {
    el.setAttribute(
      "style",
      el.getAttribute("style")!.replace(/url\((["']?)([^"')]+)\1\)/g, (_, q, src) => `url(${q}${assetUrl(src)}${q})`),
    );
  }
}

export function SlidePreview(props: SlidePreviewProps) {
  const [count, setCount] = createSignal(0);
  const [themes, setThemes] = createSignal<string[]>([]);
  const [theme, setTheme] = createSignal("");
  const [menu, setMenu] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let root: ShadowRoot | undefined;
  let cleanup: (() => void) | undefined;
  let rendering = 0;

  const slides = () => [...(root?.querySelectorAll<SVGElement>("svg[data-marpit-svg]") ?? [])];
  const mark = (scroll: boolean) => {
    slides().forEach((s, i) => {
      s.classList.toggle("current", i === ui.slide);
      if (i === ui.slide && scroll) s.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const render = async () => {
    if (!host) return;
    const seq = ++rendering;
    const deck = await renderDeck(await props.markdown());
    if (seq !== rendering || !host) return;
    root ??= host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${localCss(deck.css)}\n${PREVIEW_CSS}</style>${deck.html}`;
    resolveImages(root, props.assetUrl);
    cleanup?.();
    cleanup = await marpBrowser(root);
    setCount(deck.slides.length);
    setThemes(deck.themes);
    setTheme(deck.theme);
    mark(false);
  };

  createEffect(
    on(
      () => [ui.slidePreview, ui.docSeq] as const,
      ([shown]) => {
        document.body.classList.toggle("slide-preview-open", shown);
        if (shown) void render().catch(report);
      },
    ),
  );
  createEffect(on(() => ui.slide, () => mark(true), { defer: true }));
  onCleanup(() => cleanup?.());

  return (
    <Show when={ui.slidePreview}>
      <div id="marp-preview">
        <div class="marp-preview-header">
          <span class="marp-preview-title">Slides</span>
          <span class="marp-preview-count">{count() ? `${Math.min(ui.slide + 1, count())} / ${count()}` : ""}</span>
          <div class="marp-preview-theme">
            <button
              class="marp-preview-btn marp-preview-theme-btn"
              title={ui.sourceMode ? "Leave source mode to change the theme" : "Slide theme"}
              disabled={ui.sourceMode || !theme()}
              onClick={() => {
                setMenu(!menu());
                // Themes just added to the folder show up.
                if (menu()) void render().catch(report);
              }}
              onBlur={() => setMenu(false)}
            >
              {theme()} ▾
            </button>
            <Show when={menu()}>
              <ul class="dropdown-menu context-menu show" role="menu">
                <For each={themes()}>
                  {(name) => (
                    <li data-theme={name}>
                      <a
                        role="menuitem"
                        classList={{ "state-on": name === theme(), "state-off": name !== theme() }}
                        // Before the button's blur closes the menu.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setMenu(false);
                          if (name !== theme()) props.setTheme(name);
                        }}
                      >
                        {name}
                      </a>
                    </li>
                  )}
                </For>
                <li class="divider" />
                <li data-action="folder">
                  <a
                    role="menuitem"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setMenu(false);
                      props.openThemeFolder();
                    }}
                  >
                    Open Theme Folder
                  </a>
                </li>
              </ul>
            </Show>
          </div>
          <button class="marp-preview-btn" title="Close" onClick={() => setUi("slidePreview", false)}>
            ×
          </button>
        </div>
        <div
          class="marp-preview-slides"
          ref={(el) => {
            host = el;
            root = undefined;
          }}
          onClick={(e) => {
            const svg = e.composedPath().find((t): t is SVGElement => t instanceof SVGElement && t.hasAttribute("data-marpit-svg"));
            const index = svg ? slides().indexOf(svg) : -1;
            if (index >= 0) props.gotoSlide(index);
          }}
        />
      </div>
    </Show>
  );
}

const PREVIEW_CSS = `
:host { display: block; }
/* Blocks, not a flex column: WebKit makes a flex item's slide SVG taller than the
   slide, which shows as bands above and below it on a dark theme. */
div.marpit { padding: 4px 14px 20px; }
div.marpit > svg[data-marpit-svg] + svg[data-marpit-svg] { margin-top: 14px; }
div.marpit > svg[data-marpit-svg] {
  display: block;
  width: 100%;
  height: auto;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.15s;
}
div.marpit > svg[data-marpit-svg].current { outline-color: #4078c0; }
`;
