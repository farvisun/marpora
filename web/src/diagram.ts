// Diagrams in code fences, as Typora draws them: ```mermaid (mermaid 11.13, Typora's
// version and options), ```sequence (js-sequence-diagrams 1.0.6, vendor/) and ```flow (flowchart.js),
// the latter two on Raphaël. Each library loads the first time it is needed.

export type DiagramKind = "mermaid" | "sequence" | "flow";

/** The diagram a fence's language asks for, if any. */
export function diagramKind(lang: string): DiagramKind | null {
  const l = lang.trim().toLowerCase();
  return l === "mermaid" || l === "sequence" || l === "flow" ? l : null;
}

interface Drawable {
  drawSVG(container: HTMLElement, options: Record<string, unknown>): void;
}

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string, container?: Element): Promise<{ svg: string }>;
}

declare global {
  interface Window {
    Raphael?: unknown;
    _?: unknown;
    Diagram?: { parse(text: string): Drawable };
  }
}

let mermaidLoad: Promise<MermaidApi> | null = null;
let flowLoad: Promise<{ parse(text: string): Drawable }> | null = null;
let sequenceLoad: Promise<{ parse(text: string): Drawable }> | null = null;
let mermaidConfigured = false;

function mermaid(): Promise<MermaidApi> {
  mermaidLoad ??= import("mermaid").then((m) => m.default as unknown as MermaidApi);
  return mermaidLoad;
}

interface RaphaelStatic {
  getRGB(colour: string): { hex: string; error?: boolean };
}

let raphaelLoad: Promise<RaphaelStatic> | null = null;

function raphael(): Promise<RaphaelStatic> {
  raphaelLoad ??= import("raphael").then((m) => (m.default ?? m) as RaphaelStatic);
  return raphaelLoad;
}

function flowchart() {
  flowLoad ??= import("flowchart.js").then((m) => (m.default ?? m) as { parse(text: string): Drawable });
  return flowLoad;
}

/**
 * Typora's changes to js-sequence-diagrams 1.0.6: lines, boxes and text in the text
 * colour over the page background, instead of black on white.
 */
const SEQUENCE_PATCHES: [string, string][] = [
  [
    'LINE={stroke:"#000","stroke-width":2},RECT={fill:"#fff"}',
    'LINE={stroke:"currentColor","stroke-width":2,fill:"var(--bg-color)"},RECT={fill:"transparent"}',
  ],
  ['r.attr({fill:"#fff",stroke:"none"})', 'r.attr({stroke:"none"})'],
  [
    'this._font={"font-size":16,"font-family":"Andale Mono, monospace"}',
    'this._font={"font-size":16,"font-family":"Andale Mono, monospace",fill:"currentColor"}',
  ],
];

/** js-sequence-diagrams is a classic script that expects `Raphael` and `_` globals. */
function sequence() {
  sequenceLoad ??= (async () => {
    const [R, lodash, { default: sequenceSource }] = await Promise.all([
      raphael(),
      import("lodash/core"),
      import("../vendor/js-sequence-diagrams/sequence-diagram-min.js?raw"),
    ]);
    window.Raphael = R;
    const _ = lodash.default ?? lodash;
    // The script was written for underscore: `all`, and `each` with a `this` argument.
    type Fn = (...args: unknown[]) => unknown;
    const bound = (fn: Fn, self?: unknown) => (self === undefined ? fn : fn.bind(self));
    window._ = {
      ..._,
      each: (list: unknown, fn: Fn, self?: unknown) => _.each(list, bound(fn, self)),
      all: (list: unknown, fn: Fn, self?: unknown) => _.every(list, bound(fn, self)),
    };
    let source = sequenceSource.replace(/\/\/# sourceMappingURL=.*$/m, "");
    for (const [from, to] of SEQUENCE_PATCHES) {
      if (!source.includes(from)) throw new Error(`sequence diagrams: patch target missing: ${from}`);
      source = source.replace(from, to);
    }
    const script = document.createElement("script");
    script.textContent = source;
    document.head.append(script);
    script.remove();
    return window.Diagram!;
  })();
  return sequenceLoad;
}

/** A theme setting, read from CSS variables as Typora does (see base.css :root). */
function cssVar(name: string, style = getComputedStyle(document.body)): string {
  return style.getPropertyValue(name).replace(/(^[\s'"]+)|([\s'"]+$)/g, "").toLowerCase();
}

/** Typora's mermaid configuration for the current theme. */
export function mermaidOptions(): Record<string, unknown> {
  const style = getComputedStyle(document.body);
  const raw = (name: string) => style.getPropertyValue(name).trim();
  let theme = cssVar("--mermaid-theme", style) || "default";
  const numbers = cssVar("--mermaid-sequence-numbers", style) === "on";
  let curve: string | undefined = cssVar("--mermaid-flowchart-curve", style);
  if (!["linear", "basis", "step", "natural"].includes(curve)) curve = undefined;
  let leftPadding = parseFloat(cssVar("--mermaid--gantt-left-padding", style));
  if (Number.isNaN(leftPadding)) leftPadding = 75;
  const fontFamily = raw("--mermaid-font-family") || '"trebuchet ms", verdana, arial, sans-serif';
  let themeVariables: Record<string, unknown> = {};
  let dark = theme === "night" || theme === "dark";
  if (theme === "night") {
    themeVariables = { darkMode: false, fontFamily };
    theme = "dark";
  } else if (!["base", "default", "dark", "forest", "neutral"].includes(theme)) {
    // A theme of the theme's own: mermaid's base theme in the theme's colours.
    const fill = raw("--node-fill");
    dark = /^#[0-9a-f]{6}$/i.test(fill) ? brightness(fill) < 40 : false;
    themeVariables = {
      darkMode: dark,
      fontFamily,
      noteTextColor: raw("--text-color"),
      primaryColor: fill,
      background: raw("--mermaid-background") || raw("--bg-color"),
      noteBkgColor: raw("--cluster-fill"),
      textColor: raw("--node-text-color") || raw("--text-color"),
    };
    if (fill.toUpperCase() === "#ECECFF" && !dark) themeVariables.secondaryColor = "#f4f4f4";
    theme = "base";
  }
  return {
    securityLevel: "strict",
    theme,
    themeVariables,
    darkMode: dark,
    altFontFamily: "sans-serif",
    fontFamily: "sans-serif",
    startOnLoad: false,
    flowchart: { htmlLabels: true, useMaxWidth: true, curve },
    sequence: { showSequenceNumbers: numbers, useMaxWidth: false, diagramMarginX: 8, diagramMarginY: 8, boxMargin: 8 },
    gantt: { leftPadding, rightPadding: 20 },
  };
}

function brightness(hex: string): number {
  const c = (i: number) => parseInt(hex.substr(i, 2), 16);
  return (299 * c(1) + 587 * c(3) + 114 * c(5)) / 1000;
}

/** Re-read the theme's mermaid settings (after a theme change). */
export function resetMermaidTheme() {
  mermaidConfigured = false;
}

/**
 * Raphaël resolves `currentColor` and `var(--bg-color)` to fixed colours when it draws
 * (and caches them), so a later theme change would leave the old colours behind. Put
 * the references back so sequence and flow charts follow the theme.
 */
function liveColours(R: RaphaelStatic, root: Element) {
  const swaps = new Map<string, string>();
  for (const css of ["currentColor", "var(--bg-color)"]) {
    const rgb = R.getRGB(css);
    if (!rgb.error) swaps.set(rgb.hex.toLowerCase(), css);
  }
  for (const el of root.querySelectorAll("svg *")) {
    for (const attr of ["stroke", "fill"]) {
      const swap = swaps.get(el.getAttribute(attr)?.toLowerCase() ?? "");
      if (swap) el.setAttribute(attr, swap);
    }
  }
}

let chartId = 0;

export interface DiagramResult {
  /** Mermaid's diagram type (`aria-roledescription`), for `[mermaid-type]` styling. */
  mermaidType?: string;
}

/**
 * Draw `text` into `preview`. Throws with Typora's message (`ERROR: [Mermaid] …`) when
 * the source does not parse.
 */
export async function drawDiagram(kind: DiagramKind, text: string, preview: HTMLElement): Promise<DiagramResult> {
  const fail = (label: string, e: unknown): never => {
    const message = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    throw new Error(`ERROR: [${label}] ${message}`);
  };
  if (kind === "mermaid") {
    const api = await mermaid();
    if (!mermaidConfigured) {
      try {
        api.initialize(mermaidOptions());
      } catch {
        api.initialize({ ...mermaidOptions(), theme: "default", themeVariables: {} });
      }
      mermaidConfigured = true;
    }
    if (!text.trim()) {
      preview.innerHTML = "<text>Empty Diagram</text>";
      return {};
    }
    let svg: string;
    try {
      ({ svg } = await api.render(`mermaidChart${chartId++}`, text, preview));
    } catch (e) {
      return fail("Mermaid", e);
    }
    preview.innerHTML = svg;
    const el = preview.querySelector("svg");
    el?.classList.add("mermaid-svg");
    return { mermaidType: el?.getAttribute("aria-roledescription") ?? undefined };
  }
  if (kind === "sequence") {
    const Diagram = await sequence();
    let diagram: Drawable;
    try {
      diagram = Diagram.parse(text || "title: Empty Diagram");
    } catch (e) {
      return fail("Sequence", e);
    }
    preview.innerHTML = "";
    diagram.drawSVG(preview, { theme: cssVar("--sequence-theme") === "hand" ? "hand" : "simple" });
    liveColours(await raphael(), preview);
    // Wider than the page: scaled down to fit, as in Typora.
    const svg = preview.querySelector("svg");
    const width = parseFloat(svg?.getAttribute("width") ?? "");
    const scale = preview.parentElement!.clientWidth / width;
    if (svg && scale < 1) svg.style.setProperty("zoom", String(scale));
    return {};
  }
  const flow = await flowchart();
  try {
    const chart = flow.parse(text.replace(/\r/g, "") || "st=>start: Empty Diagram\ne=>end\nst->e");
    preview.innerHTML = "";
    chart.drawSVG(preview, {
      y: 0,
      "font-color": "currentColor",
      "line-color": "currentColor",
      "element-color": "currentColor",
      fill: "var(--bg-color)",
    });
    liveColours(await raphael(), preview);
  } catch (e) {
    return fail("Flowchart", e);
  }
  return {};
}
