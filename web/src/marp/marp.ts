// Marp slide decks: a document whose front matter says `marp: true` is a deck, its
// slides split at each `---` rule. Rendering uses Marp Core, loaded only when a deck
// is shown.

import type { Node as PMNode } from "prosemirror-model";
import { frontMatterValue } from "../editor/frontmatter";
import { schema } from "../editor/schema";
import { mathJaxSettled } from "../math";

export function isDeck(doc: PMNode): boolean {
  return frontMatterValue(doc, "marp") === "true";
}

/** The slide the position `pos` is on: the number of top-level rules before it. */
export function slideAt(doc: PMNode, pos: number): number {
  let slide = 0;
  doc.forEach((node, offset) => {
    if (offset < pos && node.type === schema.nodes.horizontal_rule) slide++;
  });
  return slide;
}

/** Where slide `index` starts: just after its rule (the document's start for the first). */
export function slideStart(doc: PMNode, index: number): number {
  let seen = 0;
  let at = 0;
  doc.forEach((node, offset) => {
    if (seen < index && node.type === schema.nodes.horizontal_rule && ++seen === index) at = offset + node.nodeSize;
  });
  return index === 0 ? 0 : at;
}

export interface Rendered {
  html: string;
  css: string;
  /** The slides, one HTML string each (for presenting and export). */
  slides: string[];
  /** Each slide's speaker notes (`<!-- ... -->` comments). */
  notes: string[];
}

type MarpModule = typeof import("@marp-team/marp-core");
let marpModule: Promise<MarpModule> | null = null;

/** Marp Core, which bundles MathJax 3: while its module runs, that MathJax registers
 * its packages with a global `MathJax.loader` if there is one, and the editor's
 * MathJax 4 throws on them. So the editor's MathJax loads first (it keeps its own
 * handle), and the global is hidden while Marp's module runs. */
async function loadMarp(): Promise<MarpModule> {
  await mathJaxSettled();
  const w = window as { MathJax?: unknown };
  const editorMathJax = w.MathJax;
  delete w.MathJax;
  try {
    return await import("@marp-team/marp-core");
  } finally {
    if (editorMathJax !== undefined) w.MathJax = editorMathJax;
  }
}

/** Marp Core's renderer: HTML limited to Marp's safe list, math with MathJax. */
/** `script`: put Marp's browser helper inline in the HTML, for a page shown on its own
 * (Safari scales inline SVG slides wrongly without it). `plain`: slides as bare
 * sections at their own size rather than scalable inline SVG, for printing. */
export async function renderDeck(markdown: string, { script = false, plain = false } = {}): Promise<Rendered> {
  marpModule ??= loadMarp();
  const { Marp } = await marpModule;
  const marp = new Marp({ inlineSVG: !plain, math: "mathjax", script: script ? { source: "inline" } : false });
  const { html, css, comments } = marp.render(markdown);
  const slides = marp.render(markdown, { htmlAsArray: true }).html;
  return { html, css, slides, notes: comments.map((c) => c.join("\n\n")) };
}

/** A deck's CSS for showing in the app: without `@charset` and the web font imports
 * some themes have (Gaia's from fonts.bunny.net), so the app fetches nothing on its
 * own and works offline; a pending import would also hold back the whole sheet in a
 * shadow root. Exports keep them. */
export function localCss(css: string): string {
  return css.replace(/@charset\s+"[^"]*"\s*;/gi, "").replace(/@import\s+(?:url\()?\s*["']?https?:[^;]*;/gi, "");
}

/** Apply Marp's browser fixes (WebKit's scaling of inline SVG slides) under `root`. */
export async function marpBrowser(root: ParentNode): Promise<() => void> {
  const { browser } = await import("@marp-team/marp-core/browser");
  const b = browser(root);
  return () => b.cleanup();
}
