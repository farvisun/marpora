// The diagram under a ```mermaid / ```sequence / ```flow fence, with Typora's markup:
// the fence becomes `md-diagram md-fences-advanced` and gains a `.md-diagram-panel`.
// Unfocused, CSS hides the code and shows the diagram; focused, the diagram hangs
// under the code and the fence's bottom margin makes room for it, as Typora does.
//
// Panels attach when their fence first comes near the screen, so a long document
// does not draw every diagram up front.

import { type DiagramKind, drawDiagram, resetMermaidTheme } from "../diagram";

const panels = new Map<Element, DiagramPanel>();

const observer =
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const e of entries) if (e.isIntersecting) panels.get(e.target)?.show();
        },
        { rootMargin: "800px 0px" },
      );

export class DiagramPanel {
  readonly panel: HTMLElement;
  private preview: HTMLElement;
  private error: HTMLElement;
  private visible = false;
  private focused = false;
  private drawn: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drawing: Promise<void> = Promise.resolve();

  constructor(
    private fence: HTMLElement,
    private kind: DiagramKind,
    private text: string,
  ) {
    this.panel = document.createElement("div");
    this.panel.className = "md-diagram-panel md-fences-adv-panel";
    this.panel.contentEditable = "false";
    const header = document.createElement("div");
    header.className = "md-diagram-panel-header md-fences-adv-panel-header";
    this.preview = document.createElement("div");
    this.preview.className = "md-diagram-panel-preview md-fences-adv-panel-preview";
    this.error = document.createElement("div");
    this.error.className = "md-diagram-panel-error md-fences-adv-panel-error";
    this.panel.append(header, this.preview, this.error);
    panels.set(fence, this);
    if (observer) observer.observe(fence);
    else this.show();
  }

  /** The fence came near the screen: attach and draw. */
  show() {
    if (this.visible) return;
    this.visible = true;
    observer?.unobserve(this.fence);
    this.fence.classList.add("md-diagram", "md-fences-advanced");
    this.fence.append(this.panel);
    void this.draw();
  }

  /** New source or kind: redraw shortly, as typing settles (Typora waits 200ms). */
  set(kind: DiagramKind, text: string) {
    if (kind === this.kind && text === this.text) return;
    this.kind = kind;
    this.text = text;
    if (!this.visible) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.draw(), 200);
  }

  setFocused(focused: boolean) {
    this.focused = focused;
    this.layout();
  }

  /** Draw again even if the source is unchanged (theme change). */
  redraw() {
    this.drawn = null;
    if (this.visible) void this.draw();
  }

  /** Attach and draw without waiting for the screen or the typing delay. */
  drawNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.visible) void this.draw();
    else this.show();
  }

  settled(): Promise<void> {
    return this.drawing;
  }

  private draw(): Promise<void> {
    this.drawing = this.drawing.then(async () => {
      const key = `${this.kind}\0${this.text}`;
      if (key === this.drawn || !panels.has(this.fence)) return;
      this.drawn = key;
      this.fence.removeAttribute("mermaid-type");
      if (this.kind === "mermaid") {
        const first = this.text.match(/^\s*(\w+)/m)?.[1] ?? "";
        this.fence.setAttribute("mermaid-type", first.toLowerCase());
      }
      try {
        const out = await drawDiagram(this.kind, this.text, this.preview);
        this.error.textContent = "";
        if (out.mermaidType) this.fence.setAttribute("mermaid-type", out.mermaidType);
      } catch (e) {
        this.error.textContent = e instanceof Error ? e.message : String(e);
      }
      this.layout();
    });
    return this.drawing;
  }

  private layout() {
    this.fence.style.marginBottom = this.focused && this.visible ? `${this.panel.offsetHeight + 50}px` : "";
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    observer?.unobserve(this.fence);
    panels.delete(this.fence);
    this.panel.remove();
    this.fence.classList.remove("md-diagram", "md-fences-advanced");
    this.fence.removeAttribute("mermaid-type");
    this.fence.style.marginBottom = "";
  }
}

/** Draw every diagram now, including those not yet near the screen (export). */
export async function drawAllDiagrams(): Promise<void> {
  const all = [...panels.values()];
  for (const p of all) p.drawNow();
  await Promise.all(all.map((p) => p.settled()));
}

/** Redraw every diagram in the current theme's colours. */
export function refreshDiagrams() {
  resetMermaidTheme();
  for (const p of panels.values()) p.redraw();
}
