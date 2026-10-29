// Format › Image: the image under the cursor, its zoom, its syntax and its file.

import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "./schema";

export interface ImageAt {
  pos: number;
  node: PMNode;
  src: string;
  alt: string;
  title: string;
  /** The `zoom` of an HTML image's style, such as "50%". */
  zoom: string | null;
  /** Written as `<img>` rather than `![]()`. */
  html: boolean;
}

/** The `<img>` tag `html` is, if it is one. */
function parseImg(html: string): HTMLImageElement | null {
  if (!/^\s*<img\b/i.test(html)) return null;
  const t = document.createElement("template");
  t.innerHTML = html;
  const img = t.content.firstElementChild;
  return img instanceof HTMLImageElement && img.hasAttribute("src") ? img : null;
}

/** `node`, at `pos`, as an image, if it is one. */
export function imageNode(node: PMNode, pos: number): ImageAt | null {
  if (node.type === schema.nodes.image) {
    const { src, alt, title } = node.attrs;
    return { pos, node, src, alt, title, zoom: null, html: false };
  }
  if (node.type !== schema.nodes.html_inline) return null;
  const img = parseImg(node.attrs.html);
  if (!img) return null;
  return {
    pos,
    node,
    src: img.getAttribute("src") ?? "",
    alt: img.getAttribute("alt") ?? "",
    title: img.getAttribute("title") ?? "",
    zoom: img.style.getPropertyValue("zoom") || null,
    html: true,
  };
}

/** The selected image, or the one beside the cursor. */
export function imageAt(state: EditorState): ImageAt | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return imageNode(sel.node, sel.from);
  const $pos = sel.$from;
  const after = $pos.nodeAfter && imageNode($pos.nodeAfter, $pos.pos);
  if (after) return after;
  return $pos.nodeBefore ? imageNode($pos.nodeBefore, $pos.pos - $pos.nodeBefore.nodeSize) : null;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Typora's `<img>`: `<img src="a.png" alt="a" style="zoom:50%;" />`. */
export function imgHtml(attrs: { src: string; alt: string; title: string; style?: string }): string {
  const title = attrs.title ? ` title="${escape(attrs.title)}"` : "";
  const style = attrs.style ? ` style="${escape(attrs.style)}"` : "";
  return `<img src="${escape(attrs.src)}" alt="${escape(attrs.alt)}"${title}${style} />`;
}

/** Put `node` in place of the image, selected. */
function replaceImage(view: EditorView, at: ImageAt, node: PMNode) {
  const tr = view.state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, node);
  tr.setSelection(NodeSelection.create(tr.doc, at.pos));
  view.dispatch(tr.scrollIntoView());
}

/** The style an HTML image keeps besides its zoom. */
function otherStyle(at: ImageAt): string {
  const img = at.html ? parseImg(at.node.attrs.html) : null;
  if (!img) return "";
  img.style.removeProperty("zoom");
  return img.getAttribute("style")?.trim() ?? "";
}

/** Format › Image › Zoom Image: an `<img>` with `zoom:pct%`; 100% drops the zoom. */
export function setImageZoom(view: EditorView, pct: number): boolean {
  const at = imageAt(view.state);
  if (!at) return false;
  const rest = otherStyle(at);
  const zoom = pct === 100 ? "" : `zoom:${pct}%;`;
  const style = [rest && (rest.endsWith(";") ? rest : `${rest};`), zoom].filter(Boolean).join(" ");
  if (!style && !at.html) return true;
  replaceImage(view, at, schema.nodes.html_inline.create({ html: imgHtml({ ...at, style }) }));
  return true;
}

/** Format › Image › Switch Image Syntax: `![]()` or `<img>`. */
export function switchImageSyntax(view: EditorView, html: boolean): boolean {
  const at = imageAt(view.state);
  if (!at) return false;
  if (at.html === html) return true;
  const { src, alt, title } = at;
  const node = html
    ? schema.nodes.html_inline.create({ html: imgHtml({ src, alt, title }) })
    : schema.nodes.image.create({ src, alt, title });
  replaceImage(view, at, node);
  return true;
}

/** The image `at` pointing at `src`, in the same syntax. */
export function withSrc(at: ImageAt, src: string): PMNode {
  if (!at.html) return schema.nodes.image.create({ ...at.node.attrs, src });
  const style = parseImg(at.node.attrs.html)?.getAttribute("style") ?? undefined;
  return schema.nodes.html_inline.create({ html: imgHtml({ ...at, src, style }) });
}

/** Point the image at `src` (after its file moved), keeping its syntax. */
export function setImageSrc(view: EditorView, at: ImageAt, src: string) {
  replaceImage(view, at, withSrc(at, src));
}

/** Remove the image from the document. */
export function removeImage(view: EditorView, at: ImageAt) {
  view.dispatch(view.state.tr.delete(at.pos, at.pos + at.node.nodeSize).scrollIntoView());
}
