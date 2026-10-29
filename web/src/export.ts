// HTML export, as Typora does it: the document's own DOM, without the editing
// machinery, in `body.typora-export` with the window's CSS inlined. Math and diagrams go
// in as the SVG already drawn, so the page needs no scripts. Like Typora, the page
// carries no web fonts (`@font-face` rules are left out).
//
// The same page is what PDF export prints.

import type { EditorView } from "prosemirror-view";
import { drawAllDiagrams } from "./editor/diagramview";
import { mathBlocksIdle } from "./editor/mathblock";
import { frontMatterValue, rootedSrc } from "./editor/frontmatter";
import { imageSource } from "./editor/nodeviews";
import { mathIdle } from "./math";

export interface ExportOptions {
  /** The document's path, which image paths are relative to. */
  docPath: string | null;
  /** Where the page will be written, for image paths relative to it. */
  target: string | null;
  /** Leave out the theme and base CSS ("HTML (without styles)"). */
  plain?: boolean;
  /** A page to print (PDF export, Print): images by absolute `file://` URL. */
  print?: boolean;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The standalone page for the document in `view`. */
export async function exportHtml(view: EditorView, options: ExportOptions): Promise<string> {
  await drawAllDiagrams();
  await mathBlocksIdle();
  await mathIdle();

  const source = view.dom;
  const write = source.cloneNode(true) as HTMLElement;
  const sourceImages = source.querySelectorAll("img");
  const root = frontMatterValue(view.state.doc, "typora-root-url");
  write.querySelectorAll("img").forEach((img, i) => {
    const src = imageSource(sourceImages[i]);
    if (src !== undefined) img.setAttribute("src", imagePath(rootedSrc(src, root), options));
  });
  clean(write);

  const title = `<title>${escapeHtml(pageTitle(write, options.docPath))}</title>`;
  const meta = "<meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1'>";
  if (options.plain) {
    return `<!doctype html>\n<html>\n<head>\n${meta}\n${title}\n</head>\n<body>${write.innerHTML}</body>\n</html>`;
  }
  const extra = options.print ? [...EXTRA_CSS, ...printCss(source)] : EXTRA_CSS;
  const styles = [...(await collectCss()), ...extra].map(([id, css]) => style(css, id)).join("\n");
  return (
    `<!doctype html>\n<html>\n<head>\n${meta}${style("html {overflow-x: initial !important;}")}\n` +
    `${styles}\n\n${title}\n</head>\n` +
    `<body class='typora-export${options.print ? " typora-print" : ""}'><div class='typora-export-content'>\n` +
    `<div id='write'  class='${options.print ? "is-mac" : ""}'>${write.innerHTML}</div></div>\n</body>\n</html>`
  );
}

/**
 * Typora's rules for printing on the Mac: the print job sets the page margins, and a
 * heading keeps 100px of room under it so it does not end a page.
 */
function printCss(write: HTMLElement): [string, string][] {
  const keep = [""];
  for (let level = 1; level < 7; level++) {
    const h = write.querySelector(`h${level}`);
    if (!h) continue;
    const s = getComputedStyle(h);
    const plain =
      /^0px/.test(s.border) &&
      / 0px$/.test(s.outline) &&
      s.boxShadow === "none" &&
      s.backgroundImage === "none" &&
      s.backgroundColor === "rgba(0, 0, 0, 0)";
    const after = getComputedStyle(h, "::after").content;
    if (plain && (after === "none" || !after)) {
      keep.push(`.typora-export h${level}::after {content: "";display: block;height: 100px;margin-bottom: -100px;}`);
    }
  }
  return [
    ["for-print", keep.join("\n")],
    ["mac-print", " @media print { @page {margin: 0 0 0 0;} body.typora-export {padding-left: 0; padding-right: 0;} #write {padding:0;}}"],
  ];
}

function style(css: string, id?: string): string {
  return `<style type='text/css'${id ? ` id="style-${id}"` : ""}>${css}</style>`;
}

/** Rules Typora adds to every export, after the theme's. */
const EXTRA_CSS: [string, string][] = [
  ["mathjax-ni", 'mjx-container[jax="SVG"] path[data-c], mjx-container[jax="SVG"] use[data-c] {\n\tstroke-width: 0;\n}'],
  ["lp", "ol, ul {padding-left: 40px}"],
  // Single line breaks are not kept ("Preserve single line break" is off).
  [
    "preLinebreakOnExport",
    " .typora-export li, .typora-export p, .typora-export,  .footnote-line {white-space: normal;} h1,h2,h3,h4,h5 {white-space:pre-line}",
  ],
];

/** Editing-only elements: tooltips, source editors, cursor helpers. */
const EDITING_PARTS = [
  ".md-rawblock-tooltip",
  ".ty-table-edit",
  ".md-rawblock-control",
  ".md-mathblock-panel",
  ".code-tooltip",
  ".md-diagram-panel-header",
  ".md-diagram .CodeMirror",
  ".md-inline-math script",
  ".md-meta",
  ".ProseMirror-widget:not(input):not(.md-alert-text)",
  ".md-alert-src",
  ".md-softbreak-space",
  "img.ProseMirror-separator",
  '[mdtype="meta_block"]',
].join(",");

/** Classes that only describe the editing state. */
const EDITING_CLASSES = [
  "ProseMirror",
  "ProseMirror-focused",
  "ProseMirror-widget",
  "ProseMirror-selectednode",
  "ProseMirror-trailingBreak",
  "md-focus",
  "md-focus-container",
  "md-expand",
  "md-rawblock-on-edit",
  "md-img-error",
];

const REF_DEFS = /^(\s{0,3}\[[^\]]+\]:.*(\n|$)|\s+\S.*(\n|$))+$/;

function clean(write: HTMLElement) {
  for (const el of write.querySelectorAll(EDITING_PARTS)) el.remove();
  for (const el of write.querySelectorAll(".md-diagram-panel-error:empty")) el.remove();
  // Link reference definitions print nothing.
  for (const el of write.querySelectorAll('[mdtype="raw_block"]')) {
    if (REF_DEFS.test(el.textContent ?? "")) el.remove();
  }
  // Raw HTML becomes HTML.
  for (const block of write.querySelectorAll(".md-htmlblock")) {
    block.innerHTML = block.querySelector(".md-rawblock-input")?.textContent ?? "";
  }
  const parents = new Set<Element>();
  for (const el of write.querySelectorAll(".md-html-inline, .md-br")) if (el.parentElement) parents.add(el.parentElement);
  for (const parent of parents) {
    // Opening and closing tags are separate nodes, so rebuild the parent's markup.
    parent.innerHTML = [...parent.childNodes]
      .map((n) => {
        if (n instanceof Element && (n.classList.contains("md-html-inline") || n.classList.contains("md-br"))) {
          return n.textContent ?? "";
        }
        return n instanceof Element ? n.outerHTML : escapeHtml(n.textContent ?? "");
      })
      .join("");
  }
  for (const box of write.querySelectorAll<HTMLInputElement>(".task-list-item > input[type=checkbox]")) {
    box.toggleAttribute("checked", box.parentElement!.classList.contains("task-list-done"));
  }
  // A soft break is a newline in the text, which the page shows as a space.
  for (const br of write.querySelectorAll("br.md-soft-break")) br.replaceWith("\n");
  linkHeadings(write);
  collectFootnotes(write);

  for (const el of [write, ...write.querySelectorAll("*")]) {
    for (const attr of ["contenteditable", "draggable", "translate", "tabindex", "spellcheck"]) el.removeAttribute(attr);
    if (el.classList.length) el.classList.remove(...EDITING_CLASSES);
    if (el.getAttribute("class") === "") el.removeAttribute("class");
  }
  for (const fence of write.querySelectorAll<HTMLElement>(".md-fences")) fence.style.removeProperty("margin-bottom");
  for (const el of write.querySelectorAll("[style='']")) el.removeAttribute("style");
  write.setAttribute("class", write.getAttribute("class") ?? "");
}

/**
 * Footnote definitions move to a `.footnotes-area` at the end, in the order they are
 * first referenced, each linking back to its reference (Typora's export markup).
 */
function collectFootnotes(write: HTMLElement) {
  const defs = new Map<string, Element>();
  for (const def of write.querySelectorAll<HTMLElement>(".md-def-footnote[data-label]")) {
    if (!defs.has(def.dataset.label!)) defs.set(def.dataset.label!, def);
    def.remove();
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const ref of write.querySelectorAll(".md-footnote > a[name^='ref-footnote-']")) {
    const label = ref.getAttribute("name")!.slice("ref-footnote-".length);
    ref.setAttribute("href", `#dfref-footnote-${label}`);
    const def = defs.get(label);
    if (!def || seen.has(label)) continue;
    seen.add(label);
    const text = [...def.children].map((c) => (c.tagName === "P" ? c.innerHTML : c.outerHTML)).join(" ");
    lines.push(
      `<div class='footnote-line'><span class='md-fn-count'>${escapeHtml(label)}</span> ${text}` +
        ` <a name='dfref-footnote-${escapeHtml(label)}' href='#ref-footnote-${escapeHtml(label)}'` +
        " title='back to document' class='reversefootnote' >↩</a></div>",
    );
  }
  if (lines.length) write.insertAdjacentHTML("beforeend", `<div class='footnotes-area'  ><hr/>${lines.join("\n")}</div>`);
}

/** Ids on headings, as Typora makes them, and `[TOC]` entries linking to them. */
function linkHeadings(write: HTMLElement) {
  const used = new Map<string, number>();
  const ids: string[] = [];
  for (const h of write.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")) {
    const base =
      (h.textContent ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-") || "heading";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n ? `${base}-${n}` : base;
    h.id = id;
    ids.push(id);
  }
  // `[TOC]` lists the same top-level headings in order.
  for (const toc of write.querySelectorAll(".md-toc")) {
    toc.querySelectorAll("a.md-toc-inner").forEach((a, i) => {
      if (ids[i]) a.setAttribute("href", `#${ids[i]}`);
    });
  }
}

function pageTitle(write: HTMLElement, docPath: string | null): string {
  const name = docPath?.split("/").pop()?.replace(/\.[^.]*$/, "");
  if (name) return name;
  return write.querySelector("h1, h2, h3, h4, h5, h6")?.textContent?.trim() || "Untitled";
}

/** An image path as the page at `target` reaches it. */
function imagePath(src: string, { docPath, target, print }: ExportOptions): string {
  if (!src || URL_SCHEME.test(src) || src.startsWith("#") || src.startsWith("//")) return src;
  if (!docPath && !src.startsWith("/")) return src;
  const absolute = src.startsWith("/") ? decodeURI(src) : normalize(`${dirname(docPath!)}/${decodeURI(src)}`);
  if (print) return `file://${encodeURI(absolute)}`;
  return target ? encodeURI(relative(dirname(target), absolute)) : src;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return "/" + out.join("/");
}

/** `to` (absolute) relative to the directory `from` (absolute). */
export function relative(from: string, to: string): string {
  const a = normalize(from).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The window's style sheets as `[name, css]`, without `@font-face` rules, and with the
 * files they refer to (images) inlined as data URLs so the page stands alone. Sheets
 * the window cannot read (another origin) stay as `@import`s.
 */
async function collectCss(): Promise<[string, string][]> {
  const sheets: [string, string][] = [];
  const read = (sheet: CSSStyleSheet, imports: string[]): string => {
    const base = sheet.href ?? document.baseURI;
    const out: string[] = [];
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSFontFaceRule) continue;
      if (rule instanceof CSSImportRule) {
        let inner: string | null = null;
        try {
          if (rule.styleSheet) inner = read(rule.styleSheet, imports);
        } catch {
          // Another origin.
        }
        if (inner === null) imports.push(absoluteUrls(rule.cssText, base));
        else out.push(inner);
      } else {
        out.push(absoluteUrls(rule.cssText, base));
      }
    }
    return out.join("\n");
  };
  for (const sheet of document.styleSheets) {
    if (sheet.disabled) continue;
    const owner = sheet.ownerNode as Element | null;
    // Of MathJax's sheets only the SVG output's; the others style its menus.
    if (owner?.id.startsWith("MJX-") && owner.id !== "MJX-SVG-styles") continue;
    const file = sheet.href ?? owner?.getAttribute("data-vite-dev-id");
    const name = file?.match(/([^/]+)\.css(\?|$)/)?.[1] ?? owner?.id ?? "";
    const imports: string[] = [];
    let css: string;
    try {
      css = read(sheet, imports);
    } catch {
      if (sheet.href) sheets.push([name, `@import url("${sheet.href}");`]);
      continue;
    }
    const media = sheet.media.mediaText;
    if (media && media !== "all") css = `@media ${media} {\n${css}\n}`;
    if (css.trim() || imports.length) sheets.push([name, await inlineUrls([...imports, css].join("\n"))]);
  }
  return sheets;
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function absoluteUrls(css: string, base: string): string {
  return css.replace(CSS_URL, (whole, _q: string, ref: string) => {
    if (ref.startsWith("data:") || ref.startsWith("#")) return whole;
    try {
      return `url("${new URL(ref, base).href}")`;
    } catch {
      return whole;
    }
  });
}

async function inlineUrls(css: string): Promise<string> {
  const urls = new Set<string>();
  for (const [, , ref] of css.matchAll(CSS_URL)) if (!ref.startsWith("data:") && !ref.startsWith("#")) urls.add(ref);
  const data = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const response = await fetch(url);
        if (response.ok) data.set(url, await dataUrl(await response.blob()));
      } catch {
        // Unreachable: the page keeps the reference.
      }
    }),
  );
  return css.replace(CSS_URL, (whole, _q: string, ref: string) => (data.has(ref) ? `url("${data.get(ref)}")` : whole));
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result as string);
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(blob);
  });
}
