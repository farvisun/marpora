// `$$` math blocks with Typora's markup: the rendered formula, and while the cursor is
// inside, an editing panel with the TeX between `$$` lines over a live preview.
//
// The TeX is the node's ProseMirror text, so editing, undo and sync work as for code.
// `mathPlugin` marks the block holding the cursor `md-rawblock-on-edit` (CSS swaps the
// formula for the panel before ProseMirror places the cursor), and renders every block
// in document order so equation numbers continue from one block to the next.

import type { Node as PMNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from "prosemirror-view";
import { renderTex } from "../math";

const EDITING = "md-rawblock-on-edit";

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Inert parts of the view: ProseMirror leaves them alone. */
function control(tag: string, cls: string, text?: string): HTMLElement {
  const e = el(tag, cls, text);
  e.contentEditable = "false";
  return e;
}

const ICON_CODE =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4"/></svg>';
const ICON_OK =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m2.5 8.5 3.5 3.5 7.5-8"/></svg>';

const views = new Set<MathBlockView>();

/** Whether `mathPlugin` marked the block as holding the cursor. */
function isEditing(decorations: readonly Decoration[]): boolean {
  return decorations.some((d) => d.spec.mathEditing);
}

export class MathBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private container: HTMLElement;
  private preview: HTMLElement;
  private editing = false;
  /** Rendered formula, moved between the container and the preview. */
  private formula: HTMLElement | null = null;
  /** What `formula` shows: start number and TeX. */
  private shown = "";

  constructor(
    public node: PMNode,
    private view: EditorView,
    readonly getPos: () => number | undefined,
    decorations: readonly Decoration[],
  ) {
    this.editing = isEditing(decorations);
    this.dom = el("div", "mathjax-block md-end-block md-math-block md-rawblock");
    this.dom.setAttribute("mdtype", "math_block");
    this.dom.spellcheck = false;

    const tooltip = control("div", "md-rawblock-tooltip md-rawblock-control");
    tooltip.append(el("span", "md-rawblock-tooltip-name", "Math"));
    const edit = el("span", "md-rawblock-tooltip-btn md-rawblock-tooltip-edit-btn");
    edit.setAttribute("ty-hint", "Edit");
    edit.innerHTML = ICON_CODE;
    const ok = el("span", "md-rawblock-tooltip-btn md-rawblock-tooltip-ok-btn");
    ok.setAttribute("ty-hint", "Finish Editing");
    ok.innerHTML = ICON_OK;
    tooltip.append(edit, ok);
    edit.addEventListener("mousedown", (e) => this.click(e, "end"));
    ok.addEventListener("mousedown", (e) => this.click(e, "after"));

    this.container = control("div", "md-rawblock-container md-math-container");
    this.container.tabIndex = -1;
    this.container.addEventListener("mousedown", (e) => this.click(e, "end"));

    const panel = el("div", "md-mathblock-panel md-rawblock-panel");
    const input = el("div", "md-rawblock-control md-rawblock-input md-mathblock-input");
    const cm = el("div", "CodeMirror cm-s-inner cm-s-null-scroll");
    const lines = el("div", "CodeMirror-lines");
    this.contentDOM = el("div", "CodeMirror-code");
    lines.append(this.contentDOM);
    cm.append(lines);
    input.append(cm);
    const tip = control("div", "code-tooltip");
    this.preview = el("div", "md-mathjax-preview");
    tip.append(this.preview);
    panel.append(
      control("div", "md-rawblock-control md-rawblock-before", "$$"),
      input,
      control("div", "md-rawblock-control md-rawblock-after", "$$"),
      tip,
    );

    this.dom.append(tooltip, this.container, panel);
    this.showSource();
    views.add(this);
  }

  get tex(): string {
    return this.node.textContent;
  }

  /** Before the first render: the source, dimmed, as in Typora. */
  private showSource() {
    this.container.classList.add("math-jax-preprocess");
    this.container.replaceChildren("$$", document.createElement("br"), this.tex, document.createElement("br"), "$$");
  }

  /** Show the formula rendered with equations numbered from `start`. */
  async render(start: number): Promise<number> {
    const tex = this.tex;
    const key = `${start}\0${tex}`;
    const out = await renderTex(tex, true, start);
    if (key !== this.shown && tex === this.tex) {
      this.shown = key;
      this.formula = out.node.cloneNode(true) as HTMLElement;
      this.container.classList.remove("math-jax-preprocess");
      (this.editing ? this.preview : this.container).replaceChildren(this.formula);
    }
    return out.next;
  }

  private setEditing(editing: boolean) {
    if (editing === this.editing) return;
    this.editing = editing;
    if (this.formula) (editing ? this.preview : this.container).replaceChildren(this.formula);
  }

  /** Mouse on the formula or a tooltip button: edit the TeX, or leave the block. */
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
    this.setEditing(isEditing(decorations));
    if (!this.formula) this.showSource();
    return true;
  }

  stopEvent(event: Event): boolean {
    return !this.contentDOM.contains(event.target as Node);
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(m.target);
  }

  destroy() {
    views.delete(this);
  }
}

/** Renders every math block in document order, so numbering runs on across blocks. */
class Renderer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private waiting: (() => void)[] = [];

  /** Resolves when no render is pending or running. */
  idle(): Promise<void> {
    if (!this.timer && !this.running) return Promise.resolve();
    return new Promise((done) => this.waiting.push(done));
  }

  schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private async run() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      const ordered = [...views]
        .map((v) => ({ v, pos: v.getPos() }))
        .filter((x): x is { v: MathBlockView; pos: number } => x.pos !== undefined)
        .sort((a, b) => a.pos - b.pos);
      let start = 1;
      for (const { v } of ordered) {
        if (!views.has(v)) continue;
        try {
          start = await v.render(start);
        } catch (e) {
          console.warn("math render failed:", e);
        }
      }
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        void this.run();
      } else if (!this.timer) {
        for (const done of this.waiting.splice(0)) done();
      }
    }
  }
}

const renderer = new Renderer();

/** Resolves once every math block shows its current TeX. */
export function mathBlocksIdle(): Promise<void> {
  return renderer.idle();
}

const key = new PluginKey("marpora-math");

/** The math block holding the cursor, as a node decoration the view reads. */
function editingDecoration(state: EditorState): DecorationSet {
  const { $head } = state.selection;
  for (let d = $head.depth; d > 0; d--) {
    if ($head.node(d).type.name === "math_block") {
      const from = $head.before(d);
      return DecorationSet.create(state.doc, [
        Decoration.node(from, from + $head.node(d).nodeSize, { class: EDITING }, { mathEditing: true }),
      ]);
    }
  }
  return DecorationSet.empty;
}

export const mathPlugin = new Plugin({
  key,
  props: {
    decorations: editingDecoration,
  },
  view() {
    renderer.schedule(0);
    return {
      update(view, prev) {
        // Live preview while typing, a little behind the keys as in Typora.
        if (view.state.doc !== prev.doc) renderer.schedule(100);
      },
    };
  },
});

