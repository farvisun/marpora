// Node views for nodes whose DOM depends on more than their own attrs.

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
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

function headings(doc: PMNode): Heading[] {
  const out: Heading[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name === "heading") out.push({ level: node.attrs.level, text: node.textContent, pos });
  });
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
    const list = headings(this.view.state.doc);
    const signature = list.map((h) => `${h.level}${h.text}`).join("\n");
    if (signature === this.signature) return;
    this.signature = signature;
    const content = document.createElement("p");
    content.className = "md-toc-content";
    content.setAttribute("role", "list");
    for (const h of list) {
      const item = document.createElement("span");
      item.className = `md-toc-item md-toc-h${h.level}`;
      item.setAttribute("role", "listitem");
      const a = document.createElement("a");
      a.className = "md-toc-inner";
      a.textContent = h.text;
      a.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const dom = this.view.nodeDOM(h.pos) as HTMLElement | null;
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

class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;

  constructor(
    private node: PMNode,
    private ctx: ViewContext,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "md-image";
    this.dom.setAttribute("md-inline", "image");
    this.img = document.createElement("img");
    this.dom.append(this.img);
    this.sync();
  }

  private sync() {
    const { src, alt, title } = this.node.attrs;
    this.img.src = src ? this.ctx.assetUrl(src) : "";
    imageSources.set(this.img, src);
    this.img.alt = alt;
    if (title) this.img.title = title;
    else this.img.removeAttribute("title");
    this.img.onload = () => this.dom.classList.add("md-img-loaded");
    this.img.onerror = () => this.dom.classList.add("md-img-error");
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  selectNode() {
    this.dom.classList.add("md-expand");
  }

  deselectNode() {
    this.dom.classList.remove("md-expand");
  }
}

export function nodeViews(ctx: ViewContext): Record<string, NodeViewConstructor> {
  return {
    toc: (_node, view) => {
      const t = new TocView(view);
      tocViews.add(t);
      return Object.assign(t, { destroy: () => tocViews.delete(t) });
    },
    image: (node) => new ImageView(node, ctx),
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
