// Node views for nodes whose DOM depends on more than their own attrs.

import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import { QuoteView } from "./alert";
import { FenceView } from "./fence";
import { HtmlBlockView, HtmlInlineView } from "./html";
import { MathBlockView } from "./mathblock";
import { InlineMathView } from "./mathinline";
import { TableView } from "./table";

export interface ViewContext {
  /** URL the webview can load for an image path written in the document. */
  assetUrl(src: string): string;
}

interface Heading {
  level: number;
  text: string;
  pos: number;
}

interface Outline {
  list: Heading[];
  /** What a `[TOC]` shows: levels and texts, not positions. */
  signature: string;
}

const outlines = new WeakMap<PMNode, Outline>();

/** The headings of `doc`, found once for all its `[TOC]` blocks. */
function outline(doc: PMNode): Outline {
  let out = outlines.get(doc);
  if (!out) {
    const list: Heading[] = [];
    doc.forEach((node, pos) => {
      if (node.type.name === "heading") list.push({ level: node.attrs.level, text: node.textContent, pos });
    });
    out = { list, signature: list.map((h) => `${h.level}${h.text}`).join("\n") };
    outlines.set(doc, out);
  }
  return out;
}

/** `[TOC]`, rendered with Typora's markup and kept current by `tocPlugin`. */
class TocView implements NodeView {
  dom: HTMLElement;
  private signature = "";

  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "md-toc md-end-block";
    this.dom.setAttribute("mdtype", "toc");
    this.dom.contentEditable = "false";
    this.render();
  }

  render() {
    const { list, signature } = outline(this.view.state.doc);
    if (signature === this.signature) return;
    this.signature = signature;
    const content = document.createElement("p");
    content.className = "md-toc-content";
    content.setAttribute("role", "list");
    for (const [i, h] of list.entries()) {
      const item = document.createElement("span");
      item.className = `md-toc-item md-toc-h${h.level}`;
      item.setAttribute("role", "listitem");
      const a = document.createElement("a");
      a.className = "md-toc-inner";
      a.textContent = h.text;
      a.addEventListener("mousedown", (e) => {
        e.preventDefault();
        // Positions move as the document changes; the order of headings is what's shown.
        const at = outline(this.view.state.doc).list[i];
        const dom = at && (this.view.nodeDOM(at.pos) as HTMLElement | null);
        dom?.scrollIntoView({ block: "start" });
      });
      item.append(a);
      content.append(item);
    }
    this.dom.replaceChildren(content);
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }
}

const tocViews = new Set<TocView>();

/** Re-renders `[TOC]` blocks when headings change. */
export const tocPlugin = new Plugin({
  key: new PluginKey("marpora-toc"),
  view: () => ({
    update: (view, prev) => {
      if (view.state.doc !== prev.doc) for (const t of tocViews) t.render();
    },
  }),
});

/** The path each image was written with, for export (the DOM holds a webview URL). */
const imageSources = new WeakMap<HTMLImageElement, string>();

export function imageSource(img: HTMLImageElement): string | undefined {
  return imageSources.get(img);
}

/** `![alt](src "title")` for an image's attrs. */
export function imageMarkdown(attrs: { src: string; alt: string; title: string }): string {
  const src = /[\s()<>]/.test(attrs.src) ? `<${attrs.src}>` : attrs.src;
  const title = attrs.title ? ` "${attrs.title.replace(/"/g, '\\"')}"` : "";
  return `![${attrs.alt}](${src}${title})`;
}

/** The attrs `text` spells, if it is one image's Markdown. */
export function parseImageMarkdown(text: string): { src: string; alt: string; title: string } | null {
  const m = /^!\[((?:[^\]\\]|\\.)*)\]\(\s*(?:<([^>]*)>|([^\s()]*))(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)$/.exec(text.trim());
  if (!m) return null;
  return { alt: m[1], src: m[2] ?? m[3] ?? "", title: (m[4] ?? "").replace(/\\"/g, '"') };
}

/** An image with Typora's markup. While selected (`md-expand`), or when it does not
 * load, its Markdown shows before it as editable text, which writes the attrs back. */
class ImageView implements NodeView {
  dom: HTMLElement;
  private source: HTMLElement;
  private img: HTMLImageElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private ctx: ViewContext,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "md-image";
    this.dom.setAttribute("md-inline", "image");
    this.dom.contentEditable = "false";
    this.source = document.createElement("span");
    this.source.className = "md-meta md-image-src";
    this.source.contentEditable = "plaintext-only";
    this.source.spellcheck = false;
    this.img = document.createElement("img");
    this.dom.append(this.source, this.img);
    this.source.addEventListener("input", () => this.write());
    this.source.addEventListener("keydown", (e) => this.keydown(e));
    this.img.addEventListener("mousedown", (e) => this.select(e));
    this.sync();
  }

  private sync() {
    const { src, alt, title } = this.node.attrs;
    if (document.activeElement !== this.source) this.source.textContent = imageMarkdown(this.node.attrs as never);
    const url = src ? this.ctx.assetUrl(src) : "";
    if (this.img.getAttribute("src") !== url) {
      this.dom.classList.remove("md-img-loaded", "md-img-error");
      if (url) this.img.src = url;
      else this.img.removeAttribute("src");
    }
    if (!url) this.dom.classList.add("md-img-error");
    imageSources.set(this.img, src);
    this.img.alt = alt;
    if (title) this.img.title = title;
    else this.img.removeAttribute("title");
    this.img.onload = () => {
      this.dom.classList.remove("md-img-error");
      this.dom.classList.add("md-img-loaded");
    };
    this.img.onerror = () => this.dom.classList.add("md-img-error");
  }

  /** The typed Markdown, when it reads as an image, becomes the node's attrs. */
  private write() {
    const attrs = parseImageMarkdown(this.source.textContent ?? "");
    const pos = this.getPos();
    if (!attrs || pos === undefined) return;
    const { src, alt, title } = this.node.attrs;
    if (attrs.src === src && attrs.alt === alt && attrs.title === title) return;
    const tr = this.view.state.tr.setNodeMarkup(pos, null, attrs);
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
  }

  private select(e: MouseEvent) {
    if (e.button !== 0) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    e.preventDefault();
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    this.focusSource();
  }

  /** The caret into the Markdown: into an empty alt, else at the end. */
  private focusSource() {
    if (document.activeElement === this.source) return;
    this.source.focus();
    const text = this.source.firstChild;
    const range = document.createRange();
    if (text && !this.node.attrs.alt && !this.node.attrs.src) {
      range.setStart(text, 2);
      range.collapse(true);
    } else {
      range.selectNodeContents(this.source);
      range.collapse(false);
    }
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** Arrows past the ends, Enter and Escape go back to the text around the image. */
  private keydown(e: KeyboardEvent) {
    const sel = window.getSelection();
    const len = this.source.textContent?.length ?? 0;
    const at = sel && sel.isCollapsed && this.source.contains(sel.anchorNode) ? sel.anchorOffset : -1;
    let side: -1 | 1 | 0 = 0;
    if (e.key === "Enter" || e.key === "Escape" || e.key === "ArrowDown") side = 1;
    else if (e.key === "ArrowUp" || (e.key === "ArrowLeft" && at === 0)) side = -1;
    else if (e.key === "ArrowRight" && at === len) side = 1;
    if (!side) return;
    e.preventDefault();
    const pos = this.getPos();
    if (pos === undefined) return;
    const { doc } = this.view.state;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(doc, side > 0 ? pos + 1 : pos)));
    this.view.focus();
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  selectNode() {
    this.dom.classList.add("md-expand");
    // Selected from the keyboard: into the Markdown once ProseMirror placed its selection.
    requestAnimationFrame(() => {
      if (this.dom.classList.contains("md-expand")) this.focusSource();
    });
  }

  deselectNode() {
    this.dom.classList.remove("md-expand");
    if (document.activeElement !== this.source) this.source.textContent = imageMarkdown(this.node.attrs as never);
  }

  stopEvent(event: Event) {
    return this.source.contains(event.target as Node);
  }

  ignoreMutation() {
    return true;
  }
}

export function nodeViews(ctx: ViewContext): Record<string, NodeViewConstructor> {
  return {
    toc: (_node, view) => {
      const t = new TocView(view);
      tocViews.add(t);
      return Object.assign(t, { destroy: () => tocViews.delete(t) });
    },
    image: (node, view, getPos) => new ImageView(node, view, getPos, ctx),
    code_block: (node, view, getPos, decorations) => new FenceView(node, view, getPos, decorations),
    math_block: (node, view, getPos, decorations) => new MathBlockView(node, view, getPos, decorations),
    math_inline: (node, view, getPos) => new InlineMathView(node, view, getPos),
    html_block: (node, view, getPos, decorations) =>
      new HtmlBlockView(node, view, getPos, decorations, (src) => ctx.assetUrl(src)),
    html_inline: (node) => new HtmlInlineView(node, (src) => ctx.assetUrl(src)),
    table: (node, view, _getPos, decorations) => new TableView(node, view, decorations),
    blockquote: (node) => new QuoteView(node),
  };
}
