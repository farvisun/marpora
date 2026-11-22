// Opening links as Typora does: ⌘-click (Ctrl-click elsewhere) or Format › Hyperlink
// Actions. The backend opens addresses and files (src-tauri links.rs); `#heading` links
// scroll to the heading here.

import type { Mark, Node as PMNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { report } from "../ipc";
import { schema } from "./schema";

export interface LinkOptions {
  /** Open `href`; resolves to a heading to scroll to for `#…` links. */
  openLink?(href: string): Promise<string | null>;
}

/** The link mark at `pos`, or around the selection when `pos` is not given. */
export function linkAt(state: EditorState, pos?: number): Mark | null {
  const $pos = state.doc.resolve(pos ?? state.selection.from);
  const marks = [...$pos.marks(), ...($pos.nodeAfter?.marks ?? [])];
  return marks.find((m) => m.type === schema.marks.link) ?? null;
}

/** Typora's heading anchors: lower case, spaces as dashes, other punctuation dropped. */
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

/** The position of the heading `anchor` names, by its text or its slug. */
export function headingFor(doc: PMNode, anchor: string): number | null {
  const want = slug(anchor);
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type === schema.nodes.heading && (node.textContent === anchor || slug(node.textContent) === want)) found = pos;
    return node.isBlock && !node.isTextblock;
  });
  return found;
}

export function scrollToHeading(view: EditorView, anchor: string): boolean {
  const pos = headingFor(view.state.doc, anchor);
  if (pos === null) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
  (view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: "start" });
  view.focus();
  return true;
}

export function openLink(view: EditorView, opts: LinkOptions, href: string) {
  if (!opts.openLink) return;
  opts.openLink(href).then((anchor) => anchor !== null && scrollToHeading(view, anchor), report);
}

const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/** ⌘-click (Ctrl-click elsewhere) opens a link; in Readonly Mode a plain click does, as in Typora. */
function opens(view: EditorView, event: MouseEvent): boolean {
  return !view.editable || (mac ? event.metaKey : event.ctrlKey);
}

/** The address of an `<a>`, HTML or SVG (MathJax's \href). */
function anchorHref(a: Element): string | null {
  return a.getAttribute("href") ?? a.getAttributeNS("http://www.w3.org/1999/xlink", "href");
}

export function linksPlugin(opts: LinkOptions): Plugin {
  return new Plugin({
    key: new PluginKey("marpora-links"),
    props: {
      handleClick(view, pos, event) {
        if (!opens(view, event)) return false;
        const link = linkAt(view.state, pos);
        if (!link?.attrs.href) return false;
        openLink(view, opts, link.attrs.href);
        return true;
      },
      handleDOMEvents: {
        // The window must never follow a link itself: that would replace the document,
        // and run a `javascript:` address in the app. Links open through `openLink`
        // only; link marks in `handleClick`, the others (\href in a formula, an <a>
        // in inline HTML) here.
        click(view, event) {
          const target = event.target as Element | null;
          const a = target?.closest?.("a");
          if (!a || !view.dom.contains(a)) return false;
          event.preventDefault();
          if (a.hasAttribute("md-inline")) return true;
          const href = anchorHref(a);
          if (!href) return true;
          // \eqref: to the equation, in this document.
          if (href.startsWith("#")) {
            const id = safeDecode(href.slice(1));
            const to = [...view.dom.querySelectorAll("[id]")].find((e) => e.id === id);
            if (to) {
              to.scrollIntoView({ block: "center" });
              return true;
            }
          }
          if (opens(view, event)) openLink(view, opts, href);
          return true;
        },
      },
    },
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
