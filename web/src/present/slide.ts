// One Marp slide shown in an element of any size, letterboxed, in a shadow root so the
// deck's CSS stays apart from the page's.

import { localCss, marpBrowser } from "../marp/marp";

const FIT = `:host { display: block; }
div.marpit { width: 100%; height: 100%; }
div.marpit > svg[data-marpit-svg] { display: block; width: 100%; height: 100%; }`;

const cleanups = new WeakMap<Element, () => void>();

/** Show slide `html` (one of Marp's inline SVG slides) with the deck's `css` in `host`. */
export async function mountSlide(host: HTMLElement, css: string, html: string | undefined): Promise<void> {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  root.innerHTML = html === undefined ? `<style>${FIT}</style>` : `<style>${localCss(css)}\n${FIT}</style><div class="marpit">${html}</div>`;
  cleanups.get(host)?.();
  if (html !== undefined) cleanups.set(host, await marpBrowser(root));
}
