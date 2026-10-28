// Code fence view: Typora's markup (see schema.ts) plus the language box shown under
// the fence holding the cursor (`.code-tooltip`, visible through `md-focus`), and for
// diagram languages the drawn diagram (diagramview.ts).

import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { Decoration, EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { diagramKind } from "../diagram";
import { DiagramPanel } from "./diagramview";
import { isFocused } from "./focus";
import { langOf } from "./schema";

export class FenceView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private cm: HTMLElement;
  /** Editable language name, a span as in Typora so its box sizes to the text. */
  private input: HTMLElement;
  private diagram: DiagramPanel | null = null;
  private focused: boolean;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    decorations: readonly Decoration[],
  ) {
    this.focused = isFocused(decorations);
    this.dom = document.createElement("pre");
    this.dom.className = "md-fences md-end-block ty-contain-cm";
    this.dom.setAttribute("mdtype", "fences");
    this.dom.spellcheck = false;

    this.cm = document.createElement("div");
    this.cm.className = "CodeMirror cm-s-inner";
    const lines = document.createElement("div");
    lines.className = "CodeMirror-lines";
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "CodeMirror-code";
    lines.append(this.contentDOM);
    this.cm.append(lines);

    const tooltip = document.createElement("div");
    tooltip.className = "code-tooltip md-fences-tooltip";
    tooltip.contentEditable = "false";
    this.input = document.createElement("span");
    this.input.className = "ty-input ty-cm-lang-input";
    // Plain text only: pasting rich text must not put markup in the language name.
    this.input.contentEditable = "plaintext-only";
    this.input.setAttribute("placeholder", "Enter language");
    this.input.spellcheck = false;
    this.input.addEventListener("input", () => this.setInfo(this.input.textContent ?? ""));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape" || e.key === "ArrowUp") {
        e.preventDefault();
        this.focusCode();
      }
    });
    tooltip.append(this.input);

    this.dom.append(this.cm, tooltip);
    // A click on the diagram edits its source.
    this.dom.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this.diagram?.panel.contains(e.target as Node)) return;
      e.preventDefault();
      this.focusCode();
    });
    this.render();
  }

  private render() {
    const lang = langOf(this.node);
    this.dom.setAttribute("lang", lang);
    this.cm.setAttribute("lang", lang);
    if (document.activeElement !== this.input) this.input.textContent = this.node.attrs.info;
    const kind = diagramKind(lang);
    if (kind && this.diagram) this.diagram.set(kind, this.node.textContent);
    else if (kind) this.diagram = new DiagramPanel(this.dom, kind, this.node.textContent);
    else if (this.diagram) {
      this.diagram.destroy();
      this.diagram = null;
    }
    this.diagram?.setFocused(this.focused);
  }

  private setInfo(info: string) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "info", info.trim()));
  }

  private focusCode() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const end = pos + this.node.nodeSize - 1;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)));
    this.view.focus();
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.focused = isFocused(decorations);
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = event.target as Node;
    return this.input.contains(target) || !!this.diagram?.panel.contains(target);
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(m.target);
  }

  destroy() {
    this.diagram?.destroy();
  }
}
