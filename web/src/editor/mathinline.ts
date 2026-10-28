// Inline `$…$` math (when the flavor enables it) with Typora's markup: the formula,
// and while the node is selected, its TeX as editable text (Typora shows it in a
// `script` element) with the rendered preview under it.
//
// The node is an atom whose TeX lives in the `tex` attr; the TeX box is outside
// ProseMirror's content, like a fence's language box, and writes the attr back.

import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Selection, TextSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { renderTex } from "../math";

export class InlineMathView implements NodeView {
  dom: HTMLElement;
  private before: HTMLElement;
  private after: HTMLElement;
  private container: HTMLElement;
  private source: HTMLElement;
  private preview: HTMLElement;
  private shown: string | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "md-inline-math";
    this.dom.setAttribute("md-inline", "math");
    this.dom.contentEditable = "false";

    this.before = meta("before");
    this.after = meta("after");
    this.container = document.createElement("span");
    this.container.className = "md-inline-math-container";
    this.source = document.createElement("script");
    this.source.setAttribute("type", "math/tex");
    this.source.contentEditable = "plaintext-only";
    this.source.spellcheck = false;
    this.container.append(this.source);

    this.preview = document.createElement("span");
    this.preview.className = "code-tooltip md-inline-math-preview";
    this.preview.contentEditable = "false";

    this.dom.append(this.before, this.container, this.after, this.preview);
    this.dom.addEventListener("mousedown", (e) => this.select(e));
    this.source.addEventListener("input", () => this.setTex(this.source.textContent ?? ""));
    this.source.addEventListener("keydown", (e) => this.keydown(e));
    this.sync();
  }

  private sync() {
    const { tex, display } = this.node.attrs;
    const fence = display ? "$$" : "$";
    this.before.textContent = fence;
    this.after.textContent = fence;
    if (document.activeElement !== this.source) this.source.textContent = tex;
    void this.render(tex);
  }

  private async render(tex: string) {
    if (tex === this.shown) return;
    const { node } = await renderTex(tex, false);
    if (tex !== this.node.attrs.tex) return;
    this.shown = tex;
    this.container.querySelector("mjx-container")?.remove();
    this.container.append(node.cloneNode(true));
    this.preview.replaceChildren(node.cloneNode(true));
  }

  private setTex(tex: string) {
    const pos = this.getPos();
    if (pos === undefined || tex === this.node.attrs.tex) return;
    const tr = this.view.state.tr.setNodeAttribute(pos, "tex", tex);
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
  }

  /** A click on the formula selects the node, which opens its TeX. */
  private select(e: MouseEvent) {
    if (e.button !== 0 || this.source.contains(e.target as Node)) return;
    e.preventDefault();
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    this.focusSource();
  }

  /** Put the caret at the end of the TeX. */
  private focusSource() {
    if (document.activeElement === this.source) return;
    this.source.focus();
    const range = document.createRange();
    range.selectNodeContents(this.source);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** Arrows past the ends of the TeX, Enter and Escape return to the text around it. */
  private keydown(e: KeyboardEvent) {
    const sel = window.getSelection();
    const len = this.source.textContent?.length ?? 0;
    const at = sel && sel.isCollapsed && this.source.contains(sel.anchorNode) ? sel.anchorOffset : -1;
    let side: -1 | 1 | 0 = 0;
    if (e.key === "Enter" || e.key === "Escape" || e.key === "ArrowDown") side = 1;
    else if (e.key === "ArrowUp") side = -1;
    else if (e.key === "ArrowRight" && at === len) side = 1;
    else if (e.key === "ArrowLeft" && at === 0) side = -1;
    if (!side) return;
    e.preventDefault();
    const pos = this.getPos();
    if (pos === undefined) return;
    const { doc } = this.view.state;
    const $pos = doc.resolve(side > 0 ? pos + this.node.nodeSize : pos);
    const sel2 = $pos.parent.inlineContent ? TextSelection.create(doc, $pos.pos) : Selection.near($pos, side);
    this.view.dispatch(this.view.state.tr.setSelection(sel2));
    this.view.focus();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  selectNode() {
    this.dom.classList.add("md-expand");
    // Selected from the keyboard: into the TeX once ProseMirror has placed its selection.
    requestAnimationFrame(() => {
      if (this.dom.classList.contains("md-expand")) this.focusSource();
    });
  }

  deselectNode() {
    this.dom.classList.remove("md-expand");
  }

  stopEvent(event: Event): boolean {
    return this.source.contains(event.target as Node);
  }

  ignoreMutation(): boolean {
    return true;
  }
}

function meta(side: string): HTMLElement {
  const e = document.createElement("span");
  e.className = `md-meta md-${side}`;
  return e;
}
