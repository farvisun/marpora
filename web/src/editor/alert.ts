// GitHub alerts (`> [!NOTE]` …) with Typora's markup: the quote becomes
// `div.md-alert.md-alert-note`, and its `[!NOTE]` line shows an icon and the label
// (`.md-alert-text-container`), the source only while the cursor is on it. The marker
// stays text in the document, so the Markdown is untouched.

import { DOMSerializer, Fragment, type Node as PMNode } from "prosemirror-model";
import { type Command, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type NodeView } from "prosemirror-view";
import { schema } from "./schema";

const n = schema.nodes;

export const ALERTS = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertType = (typeof ALERTS)[number];

const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*/i;

/** The marker's type and length, when `quote` is an alert: a quote whose first line is
 * only `[!TYPE]`, as GitHub reads them. */
export function alertOf(quote: PMNode): { type: AlertType; length: number } | null {
  if (quote.type !== n.blockquote) return null;
  const first = quote.firstChild;
  const text = first?.type === n.paragraph ? first.firstChild : null;
  if (!text?.isText || text.marks.length) return null;
  const match = MARKER.exec(text.text!);
  if (!match) return null;
  const alone = match[0].length === text.text!.length;
  const next = first!.maybeChild(1);
  if (!alone || (next && !next.type.name.endsWith("_break"))) return null;
  return { type: match[1].toLowerCase() as AlertType, length: match[0].length };
}

/** A quote, or an alert's `div`, kept in step with whether it is one. */
export class QuoteView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private type: AlertType | null;

  constructor(node: PMNode) {
    this.type = alertOf(node)?.type ?? null;
    if (this.type) {
      this.dom = this.contentDOM = document.createElement("div");
      this.dom.className = `md-alert md-alert-${this.type}`;
      this.dom.setAttribute("mdtype", "blockquote");
    } else {
      const { dom, contentDOM } = DOMSerializer.renderSpec(document, n.blockquote.spec.toDOM!(node));
      this.dom = dom as HTMLElement;
      this.contentDOM = contentDOM as HTMLElement;
    }
  }

  update(node: PMNode) {
    return node.type === n.blockquote && (alertOf(node)?.type ?? null) === this.type;
  }
}

const SVG = "http://www.w3.org/2000/svg";

/** Our own drawings for the alert icons, 16px. */
const ICONS: Record<AlertType, string> = {
  note: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 7v4.5M8 4.5v.5",
  tip: "M5.5 11.5h5M6.5 14h3M8 1.5a4.5 4.5 0 0 0-2.5 8.2V11h5V9.7A4.5 4.5 0 0 0 8 1.5z",
  important: "M2 2.5h12v9H8.5L5 14.5v-3H2zM8 4.5v3.5M8 9.5v.5",
  warning: "M8 1.8l6.7 12H1.3zM8 6.5v3.5M8 11.5v.5",
  caution: "M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2l-3.7-3.7V5.2zM8 4.5v4M8 10.5v.5",
};

function label(type: AlertType): HTMLElement {
  const outer = document.createElement("span");
  outer.className = `md-alert-text md-alert-text-${type}`;
  outer.setAttribute("md-inline", "alert_text");
  outer.contentEditable = "false";
  const container = document.createElement("span");
  container.className = "md-alert-text-container";
  container.dataset.text = type;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[type]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  container.append(svg);
  outer.append(container);
  return outer;
}

/** The label over each alert's marker, and its source while the cursor is on it. */
export const alertPlugin = new Plugin({
  key: new PluginKey("marpora-alert"),
  props: {
    decorations(state) {
      const decos: Decoration[] = [];
      const head = state.selection.head;
      state.doc.descendants((node, pos) => {
        if (node.type !== n.blockquote) return node.isBlock && !node.isTextblock;
        const alert = alertOf(node);
        if (alert) {
          const from = pos + 2;
          const to = from + alert.length;
          const editing = head >= from && head <= to;
          decos.push(
            Decoration.widget(from, () => label(alert.type), { side: -1, key: `alert-${alert.type}`, ignoreSelection: true }),
            Decoration.inline(from, to, { class: editing ? "md-alert-src md-expand" : "md-alert-src" }),
          );
        }
        return true;
      });
      return decos.length ? DecorationSet.create(state.doc, decos) : null;
    },
  },
});

/** Paragraph › Alert › …: make the quote holding the cursor that alert, or quote the
 * cursor's block as one. */
export function setAlert(type: AlertType): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
    let depth = $from.depth;
    while (depth > 0 && $from.node(depth).type !== n.blockquote) depth--;
    const marker = `[!${type.toUpperCase()}]`;
    if (!dispatch) return true;
    const tr = state.tr;
    if (depth > 0) {
      const quote = $from.node(depth);
      const start = $from.start(depth);
      const current = alertOf(quote);
      if (current) tr.insertText(marker, start + 1, start + 1 + current.length);
      else tr.insert(start + 1, [schema.text(marker), n.soft_break.create()]);
    } else {
      // A paragraph becomes the alert's text; after other blocks an empty alert goes in.
      const block = $from.depth;
      const node = $from.node(block);
      const head = Fragment.from([schema.text(marker), n.soft_break.create()]);
      if (node.type === n.paragraph) {
        const before = $from.before(block);
        tr.replaceWith(before, $from.after(block), n.blockquote.create(null, n.paragraph.create(null, head.append(node.content))));
        tr.setSelection(TextSelection.create(tr.doc, before + 2 + head.size + $from.parentOffset));
      } else {
        const after = $from.after(block);
        tr.insert(after, n.blockquote.create(null, n.paragraph.create(null, head)));
        tr.setSelection(TextSelection.create(tr.doc, after + 2 + head.size));
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}
