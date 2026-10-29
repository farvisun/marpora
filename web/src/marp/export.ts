// File › Export for a Marp deck: the slides as a page of their own, for an HTML file
// (slides one under another) or a PDF (one slide a page, at the slide's size).

import { imagePath } from "../export";
import { renderDeck } from "./marp";

export interface DeckPage {
  html: string;
  /** The slide size in CSS pixels, from the theme (1280 × 720 by default). */
  width: number;
  height: number;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/** Image references in Marp's HTML as the page at `target` reaches them. */
function resolveImages(html: string, options: { docPath: string | null; target: string | null; print?: boolean }): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const img of doc.querySelectorAll("img[src]")) img.setAttribute("src", imagePath(img.getAttribute("src")!, options));
  for (const el of doc.querySelectorAll<HTMLElement>("[style*='url(']")) {
    el.setAttribute(
      "style",
      el.getAttribute("style")!.replace(/url\((["']?)([^"')]+)\1\)/g, (_, q, src) => `url(${q}${imagePath(src, options)}${q})`),
    );
  }
  return doc.body.innerHTML;
}

/** Marp's themes place a slide's content with `align-content` on the section, which
 * WebKit ignores in print (the page is a fragmentation context). Before printing, each
 * section gets the same placement as a flex column; the printing view runs scripts. */
const PRINT_ALIGN = `for (const s of document.querySelectorAll("div.marpit > section")) {
  const a = getComputedStyle(s).alignContent;
  if (a && a !== "normal" && a !== "start" && a !== "flex-start" && a !== "stretch")
    Object.assign(s.style, { display: "flex", flexDirection: "column", justifyContent: a.replace(/^(safe|unsafe) /, "") });
}`;

export async function deckPage(
  markdown: string,
  options: { title: string; docPath: string | null; target: string | null; print?: boolean },
): Promise<DeckPage> {
  // Printed slides are bare sections: a page is exactly one slide, so nothing scales,
  // and WebKit lays out inline SVG slides wrongly in print without Marp's script.
  const deck = await renderDeck(markdown, { script: !options.print, plain: options.print });
  const size = /section\s*\{[^}]*?width:\s*(\d+(?:\.\d+)?)px;\s*height:\s*(\d+(?:\.\d+)?)px/.exec(deck.css);
  const [width, height] = size ? [Number(size[1]), Number(size[2])] : [1280, 720];
  const layout = options.print
    ? // One slide a page: Rust's `@page` rule gives the page the slide's size, so the
      // slides, stacked at that size, fall one on each page; CSS breaks (Marp's too)
      // are left out, as WebKit then loses the layout of the slides after the first.
      `html, body { margin: 0; padding: 0; background: #fff; }
div.marpit > section { break-before: auto !important; page-break-before: auto !important; break-after: auto !important; }`
    : `html, body { margin: 0; padding: 0; background: #e8e8e8; }
div.marpit { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px; }
div.marpit > svg[data-marpit-svg] { display: block; width: min(100%, ${width}px); height: auto; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
@media print { html, body { background: #fff; } div.marpit { padding: 0; gap: 0; }
  div.marpit > svg[data-marpit-svg] { box-shadow: none; width: 100%; break-after: page; } }`;
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)}</title>
<style>${deck.css}</style>
<style>${layout}</style>
</head>
<body>
${resolveImages(deck.html, options)}
${options.print ? `<script>${PRINT_ALIGN}</script>` : ""}
</body>
</html>
`;
  return { html, width, height };
}
