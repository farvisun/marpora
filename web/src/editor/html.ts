// Raw HTML rendered as Typora renders it.
//
// An HTML block shows its HTML, sanitized, in `.md-htmlblock-container`; while the
// cursor is inside, the source is edited in `.md-htmlblock-panel` above it, and the
// rendering follows as a live preview. HTML that shows nothing (a comment, a <style>)
// is shown as its dimmed source instead.
//
// Inline HTML arrives as one atom per tag. `htmlInlinePlugin` pairs an opening tag with
// its closing tag in the same paragraph and renders the text between them in that
// element; the tags themselves show only while the cursor is between them. `<br>` and
// `<img>` render as elements, with their source shown when the cursor is beside them.

import DOMPurify from "dompurify";
import type { Node as PMNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from "prosemirror-view";
import { buildAll, changedRanges, rebuild } from "./blockwise";

/** Nothing that runs or restyles the page. */
const PURIFY = { FORBID_TAGS: ["style", "link", "meta", "base", "form", "title"], FORBID_ATTR: ["autofocus"] };

export function sanitize(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, { ...PURIFY, RETURN_DOM_FRAGMENT: true });
}

/** Load relative images and media through `assetUrl`, as Typora does for HTML. */
function resolveAssets(root: ParentNode, assetUrl: (src: string) => string) {
  for (const el of root.querySelectorAll<HTMLElement>("img[src], video[src], audio[src], source[src]")) {
    el.setAttribute("src", assetUrl(el.getAttribute("src") ?? ""));
  }
}

/** Whether a fragment shows anything (a comment or an emptied <style> does not). */
function visible(fragment: DocumentFragment): boolean {
  return fragment.querySelector("*") !== null || (fragment.textContent ?? "").trim() !== "";
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function control(tag: string, cls: string, text?: string): HTMLElement {
  const e = el(tag, cls, text);
  e.contentEditable = "false";
  return e;
}

const ICON_CODE =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4"/></svg>';
const ICON_OK =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m2.5 8.5 3.5 3.5 7.5-8"/></svg>';

const EDITING = "md-rawblock-on-edit";

function isEditing(decorations: readonly Decoration[]): boolean {
  return decorations.some((d) => d.spec.htmlEditing);
}

export class HtmlBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private container: HTMLElement;
  private shown: string | null = null;

  constructor(
    public node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    decorations: readonly Decoration[],
    private assetUrl: (src: string) => string,
  ) {
    this.dom = el("div", "md-htmlblock md-rawblock md-end-block");
    this.dom.setAttribute("mdtype", "html_block");
    this.dom.spellcheck = false;
    this.dom.classList.toggle(EDITING, isEditing(decorations));

    const tooltip = control("div", "md-rawblock-tooltip md-rawblock-control");
    tooltip.append(el("span", "md-rawblock-tooltip-name", "HTML"));
    const edit = el("span", "md-rawblock-tooltip-btn md-rawblock-tooltip-edit-btn");
    edit.setAttribute("ty-hint", "Edit");
    edit.innerHTML = ICON_CODE;
    const ok = el("span", "md-rawblock-tooltip-btn md-rawblock-tooltip-ok-btn");
    ok.setAttribute("ty-hint", "Finish Editing");
    ok.innerHTML = ICON_OK;
    tooltip.append(edit, ok);
    edit.addEventListener("mousedown", (e) => this.click(e, "end"));
    ok.addEventListener("mousedown", (e) => this.click(e, "after"));

    const panel = el("div", "md-htmlblock-panel md-rawblock-control");
    const input = el("div", "md-rawblock-input");
    const cm = el("div", "CodeMirror cm-s-inner cm-s-null-scroll");
    const lines = el("div", "CodeMirror-lines");
    this.contentDOM = el("div", "CodeMirror-code");
    lines.append(this.contentDOM);
    cm.append(lines);
    input.append(cm);
    panel.append(input);

    this.container = control("div", "md-htmlblock-container md-rawblock-container");
    this.container.tabIndex = -1;
    this.container.addEventListener("mousedown", (e) => this.click(e, "end"));
    // Links in the rendering would navigate the window away from the document.
    this.container.addEventListener("click", (e) => e.preventDefault());

    this.dom.append(tooltip, panel, this.container);
    this.render();
  }

  private render() {
    const html = this.node.textContent;
    if (html === this.shown) return;
    this.shown = html;
    const fragment = sanitize(html);
    const source = !visible(fragment);
    this.container.classList.toggle("md-raw-html-src", source);
    if (source) {
      this.container.replaceChildren(el("div", "md-raw-html-src-content", html));
    } else {
      resolveAssets(fragment, this.assetUrl);
      this.container.replaceChildren(fragment);
    }
  }

  /** Mouse on the rendering or a tooltip button: edit the source, or leave the block. */
  private click(e: MouseEvent, where: "end" | "after") {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = this.getPos();
    if (pos === undefined) return;
    const { state } = this.view;
    const end = pos + this.node.nodeSize;
    const sel =
      where === "end"
        ? TextSelection.create(state.doc, end - 1)
        : (Selection.findFrom(state.doc.resolve(end), 1, true) ?? Selection.atEnd(state.doc));
    this.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    this.view.focus();
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.classList.toggle(EDITING, isEditing(decorations));
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return !this.contentDOM.contains(event.target as Node);
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(m.target);
  }
}

// Inline HTML.

/** Elements without a closing tag. */
const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"]);
/** Void elements rendered in the text. */
const RENDERED_VOID = new Set(["br", "img"]);

const OPEN = /^<([a-zA-Z][\w-]*)(\s[^>]*?)?\s*(\/?)>$/s;
const CLOSE = /^<\/([a-zA-Z][\w-]*)\s*>$/;

export interface TagPair {
  /** The opening tag atom, and the closing one. */
  open: number;
  close: number;
  /** The element, sanitized, without children: its name and attributes. */
  element: Element | null;
}

/** The element an opening tag makes, sanitized; null if it is not allowed. */
function elementOf(tag: string, name: string): Element | null {
  const fragment = sanitize(`${tag}</${name}>`);
  const element = fragment.firstElementChild;
  return element && element.localName === name.toLowerCase() ? element : null;
}

const elements = new Map<string, Element | null>();

function cachedElement(tag: string, name: string): Element | null {
  let element = elements.get(tag);
  if (element === undefined) {
    element = elementOf(tag, name);
    if (elements.size > 500) elements.clear();
    elements.set(tag, element);
  }
  return element;
}

/** Opening and closing tags paired within `block`, which starts at `base`. */
export function tagPairs(block: PMNode, base: number): TagPair[] {
  const pairs: TagPair[] = [];
  const stack: { name: string; pos: number; tag: string }[] = [];
  block.forEach((child, offset) => {
    if (child.type.name !== "html_inline") return;
    const html: string = child.attrs.html;
    const pos = base + offset;
    const close = CLOSE.exec(html);
    if (close) {
      const name = close[1].toLowerCase();
      const at = stack.findLastIndex((t) => t.name === name);
      if (at < 0) return;
      const open = stack[at];
      stack.length = at;
      pairs.push({ open: open.pos, close: pos, element: cachedElement(open.tag, open.name) });
      return;
    }
    const open = OPEN.exec(html);
    if (!open || open[3] || VOID.has(open[1].toLowerCase())) return;
    stack.push({ name: open[1].toLowerCase(), pos, tag: html });
  });
  return pairs;
}

function attrsOf(element: Element): Record<string, string> {
  const attrs: Record<string, string> = { nodeName: element.localName };
  for (const a of element.attributes) attrs[a.name] = a.value;
  return attrs;
}

/** The decorations of the inline HTML in the blocks between `from` and `to`. */
function inlineDecorations(doc: PMNode, from: number, to: number, head: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.inlineContent) return true;
    if (node.type.spec.code) return false;
    let any = false;
    node.forEach((child) => {
      any ||= child.type.name === "html_inline";
    });
    if (!any) return false;
    const base = pos + 1;
    for (const pair of tagPairs(node, base)) {
      const end = pair.close + 1;
      const expanded = head >= pair.open && head <= end;
      const tag = `md-html-tag${expanded ? "" : " md-html-tag-hidden"}`;
      decos.push(
        Decoration.node(pair.open, pair.open + 1, { class: `md-meta md-before ${tag}` }),
        Decoration.node(pair.close, end, { class: `md-meta md-after ${tag}` }),
      );
      if (pair.element && pair.open + 1 < pair.close) {
        decos.push(Decoration.inline(pair.open + 1, pair.close, attrsOf(pair.element)));
      }
    }
    // Void elements show their source beside the cursor.
    node.forEach((child, offset) => {
      const from = base + offset;
      if (child.type.name === "html_inline" && (head === from || head === from + 1) && voidName(child.attrs.html)) {
        decos.push(Decoration.node(from, from + 1, { class: "md-expand" }));
      }
    });
    return false;
  });
  return decos;
}

/** The inline HTML decorations; a block is decorated again when an edit touches it or
 * the cursor leaves or enters it. */
const inlineKey = new PluginKey<DecorationSet>("marpora-html-inline");

const inlinePlugin = new Plugin<DecorationSet>({
  key: inlineKey,
  state: {
    init: (_, state) => buildAll(state.doc, (doc, from, to) => inlineDecorations(doc, from, to, state.selection.head)),
    apply(tr, set, prev, state) {
      const head = state.selection.head;
      if (!tr.docChanged && head === prev.selection.head) return set;
      const ranges = changedRanges(tr, [tr.mapping.map(prev.selection.head), head]);
      return rebuild(set, tr, ranges, (doc, from, to) => inlineDecorations(doc, from, to, head));
    },
  },
  props: {
    decorations: (state) => inlineKey.getState(state),
  },
});

/** The name of a rendered void element (`<br>`, `<img ...>`), else null. */
function voidName(html: string): string | null {
  const open = OPEN.exec(html);
  const name = open?.[1].toLowerCase();
  return name && RENDERED_VOID.has(name) ? name : null;
}

/** An inline HTML tag: an `<img>` rendered, a `<br>` as Typora shows it (its source,
 * then the break), anything else as its source. */
export class HtmlInlineView implements NodeView {
  dom: HTMLElement;

  constructor(node: PMNode, assetUrl: (src: string) => string) {
    const html: string = node.attrs.html;
    const name = voidName(html);
    if (name === "br") {
      this.dom = el("span", "md-br md-tag");
      this.dom.setAttribute("md-inline", "br");
      this.dom.spellcheck = false;
      this.dom.append(el("span", "md-br-content md-raw-inline", html));
      return;
    }
    this.dom = el("span", "md-html-inline md-raw-inline");
    this.dom.setAttribute("md-inline", "html_inline");
    const fragment = name ? sanitize(html) : null;
    const element = fragment?.firstElementChild;
    if (element && element.localName === name) {
      resolveAssets(fragment, assetUrl);
      this.dom.className = "md-html-inline";
      this.dom.append(element, el("span", "md-raw-inline md-html-src", html));
    } else {
      this.dom.textContent = html;
    }
  }

  ignoreMutation(): boolean {
    return true;
  }
}

/** The HTML block holding the cursor, as a node decoration its view reads. */
function editingDecoration(state: EditorState): Decoration[] {
  const { $head } = state.selection;
  for (let d = $head.depth; d > 0; d--) {
    if ($head.node(d).type.name === "html_block") {
      const from = $head.before(d);
      return [Decoration.node(from, from + $head.node(d).nodeSize, { class: EDITING }, { htmlEditing: true })];
    }
  }
  return [];
}

const blockPlugin = new Plugin({
  key: new PluginKey("marpora-html"),
  props: {
    decorations(state) {
      const editing = editingDecoration(state);
      return editing.length ? DecorationSet.create(state.doc, editing) : null;
    },
  },
});

export const htmlPlugins = [inlinePlugin, blockPlugin];
