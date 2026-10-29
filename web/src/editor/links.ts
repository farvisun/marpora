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

export function linksPlugin(opts: LinkOptions): Plugin {
  return new Plugin({
    key: new PluginKey("marpora-links"),
    props: {
      handleClick(view, pos, event) {
        if (!(mac ? event.metaKey : event.ctrlKey)) return false;
        const link = linkAt(view.state, pos);
        if (!link?.attrs.href) return false;
        openLink(view, opts, link.attrs.href);
        return true;
      },
    },
  });
}
