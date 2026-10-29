// MathJax 4 with SVG output, the version and configuration Typora uses, so formulas
// render as they do there. It loads on first use from /vendor/mathjax (vite.config.ts).
//
// Conversions run one at a time: equation numbers come from MathJax's tag counter,
// which each conversion resets to the number its block starts at.

interface Tags {
  counter: number;
  allLabels: Record<string, unknown>;
}

/** Font metrics conversions use (MathJax's `getMetricsFor`). */
type Metrics = Record<string, unknown>;

interface MathItem {
  typesetRoot: HTMLElement;
}

interface MathJaxObject {
  tex2svgPromise(tex: string, options?: Metrics): Promise<HTMLElement>;
  texReset(start?: number): void;
  getMetricsFor(node: Element, display: boolean): Metrics;
  startup: {
    promise: Promise<void>;
    defaultReady(): void;
    document: {
      addStyleSheet(): void;
      removeRenderAction(id: string): void;
      addRenderAction(id: string, priority: number, doc: () => void, item: (math: MathItem) => void): void;
    };
    input: { parseOptions: { tags: Tags } }[];
  };
  _: any;
}

declare global {
  interface Window {
    // Configuration before the script loads, the MathJax object after.
    MathJax?: MathJaxObject | Record<string, unknown>;
  }
}

export interface MathOptions {
  /** Number display equations, as Typora does unless turned off. */
  autoNumber: boolean;
}

let options: MathOptions = { autoNumber: true };

/** Set before the first formula renders (changing it needs a reload, as in Typora). */
export function setMathOptions(o: Partial<MathOptions>) {
  options = { ...options, ...o };
}

export function getMathOptions(): Readonly<MathOptions> {
  return options;
}

// iTeX/HTML-style names Typora defines on top of MathJax's own.
const macros: Record<string, string | [string, number]> = {
  alef: "\\aleph", alefsym: "\\aleph", Alpha: "\\mathrm{A}", and: "\\land", ang: "\\angle",
  Beta: "\\mathrm{B}", bold: "\\mathbf", bull: "\\bullet", C: "\\mathbb{C}", Chi: "\\mathrm{X}",
  clubs: "\\clubsuit", cnums: "\\mathbb{C}", Complex: "\\mathbb{C}", coppa: "ϙ", Coppa: "Ϙ",
  Dagger: "\\ddagger", Digamma: "Ϝ", darr: "\\downarrow", dArr: "\\Downarrow", Darr: "\\Downarrow",
  diamonds: "\\diamondsuit", empty: "\\emptyset", Epsilon: "\\mathrm{E}", Eta: "\\mathrm{H}", euro: "€",
  exist: "\\exists", geneuro: "€", geneuronarrow: "€", geneurowide: "€", H: "\\mathbb{H}",
  hAar: "\\Leftrightarrow", harr: "\\leftrightarrow", Harr: "\\Leftrightarrow", hearts: "\\heartsuit",
  image: "\\Im", infin: "\\infty", Iota: "\\mathrm{I}", isin: "\\in", Kappa: "\\mathrm{K}", koppa: "ϟ",
  Koppa: "Ϟ", lang: "\\langle", larr: "\\leftarrow", Larr: "\\Leftarrow", lArr: "\\Leftarrow",
  lrarr: "\\leftrightarrow", Lrarr: "\\Leftrightarrow", lrArr: "\\Leftrightarrow", Mu: "\\mathrm{M}",
  N: "\\mathbb{N}", natnums: "\\mathbb{N}", Nu: "\\mathrm{N}", O: "\\emptyset", officialeuro: "€",
  Omicron: "\\mathrm{O}", or: "\\lor", P: "¶", pagecolor: ["", 1], part: "\\partial", plusmn: "\\pm",
  Q: "\\mathbb{Q}", R: "\\mathbb{R}", rang: "\\rangle", rarr: "\\rightarrow", Rarr: "\\Rightarrow",
  rArr: "\\Rightarrow", real: "\\Re", reals: "\\mathbb{R}", Reals: "\\mathbb{R}", Rho: "\\mathrm{P}",
  sdot: "\\cdot", sampi: "ϡ", Sampi: "Ϡ", sect: "\\S", spades: "\\spadesuit", stigma: "ϛ",
  Stigma: "Ϛ", sub: "\\subset", sube: "\\subseteq", supe: "\\supseteq", Tau: "\\mathrm{T}",
  textvisiblespace: "␣", thetasym: "\\vartheta", uarr: "\\uparrow", uArr: "\\Uparrow", Uarr: "\\Uparrow",
  varcoppa: "ϙ", varstigma: "ϛ", vline: "\\smash{\\large\\lvert}", weierp: "\\wp",
  Z: "\\mathbb{Z}", Zeta: "\\mathrm{Z}",
  dashint: "\\unicodeInt{x2A0D}", ddashint: "\\unicodeInt{x2A0E}", ointctrclockwise: "\\unicodeInt{x2233}",
  unicodeInt: ["\\mathop{\\vcenter{\\mathchoice{\\huge\\unicode{#1}\\,}{\\unicode{#1}}{\\unicode{#1}}{\\unicode{#1}}}\\,}\\nolimits", 1],
  varointclockwise: "\\unicodeInt{x2232}",
};

let loading: Promise<MathJaxObject> | null = null;

/** Load the editor's MathJax, if it is not yet; settles either way. */
export function mathJaxSettled(): Promise<unknown> {
  return load().catch(() => {});
}

function load(): Promise<MathJaxObject> {
  loading ??= new Promise<MathJaxObject>((resolve, reject) => {
    const base = `${import.meta.env.BASE_URL}vendor`;
    window.MathJax = {
      loader: {
        paths: { mathjax: `${base}/mathjax`, fonts: `${base}/@mathjax` },
        load: ["[tex]/textmacros"],
      },
      // Typora's accessibility settings: hidden MathML, and nothing that needs the
      // speech worker (not shipped). The menu applies its settings over the options.
      options: {
        menuOptions: {
          settings: {
            inTabOrder: false,
            assistiveMml: true,
            collapsible: false,
            speech: false,
            braille: false,
            enrich: false,
          },
        },
      },
      startup: {
        typeset: false,
        ready() {
          const mj = window.MathJax as MathJaxObject;
          // Typora's fix: CJK characters in the operator dictionary render as text.
          try {
            const ranges = mj._.core.MmlTree.OperatorDictionary.RANGES;
            for (const i of [28, 30, 33, 47]) ranges[i][3] = "mtext";
          } catch {}
          mj.startup.defaultReady();
          mj.startup.document.addStyleSheet();
        },
      },
      tex: {
        maxBuffer: 10 * 1024,
        processEscapes: true,
        macros,
        packages: { "[+]": ["noundefined", "autoload", "ams", "textmacros"] },
        tags: options.autoNumber ? "all" : "none",
        // A red message in place of the formula, as in Typora.
        formatError(jax: any, err: { message: string; id: string }) {
          const message = err.message.replace(/\n.*/, "");
          return jax.parseOptions.nodeFactory.create("error", message, err.id, `Error: ${message}`);
        },
        useLabelIds: true,
      },
      svg: { scale: 1 },
    };
    const script = document.createElement("script");
    script.src = `${base}/mathjax/tex-svg.js`;
    script.async = true;
    script.onerror = () => reject(new Error("MathJax failed to load"));
    script.onload = () => {
      const mj = window.MathJax as MathJaxObject;
      mj.startup.promise.then(() => resolve(prepare(mj)), reject);
    };
    document.head.append(script);
  });
  return loading;
}

/** Typora's adjustments to every conversion. */
function prepare(mj: MathJaxObject): MathJaxObject {
  const doc = mj.startup.document;
  // The editor has its own context menu.
  doc.removeRenderAction("addMenu");
  // Keep the SVG's ids and classes from clashing with the page's, and give it alt text.
  doc.addRenderAction("afterRender", 1001, () => {}, (math) => {
    const svg = math.typesetRoot.querySelector("svg");
    if (!svg) return;
    for (const e of svg.querySelectorAll("[id]")) if (!/^mjx-/i.test(e.id)) e.id = `mjx-${e.id}`;
    for (const e of svg.querySelectorAll("[class]")) {
      const keep = (e.getAttribute("class") ?? "").split(/\s+/).filter((c) => /^mjx-/i.test(c));
      e.setAttribute("class", keep.join(" "));
    }
    const label = math.typesetRoot.getAttribute("aria-label");
    if (svg.parentElement === math.typesetRoot && label) svg.setAttribute("alt", label);
  });
  return mj;
}

/**
 * Display math is converted with the metrics of the document's text, measured once
 * (as Typora does): they size text inside formulas, such as error messages.
 */
let displayMetrics: Metrics | null = null;

function metrics(mj: MathJaxObject): Metrics {
  if (!displayMetrics) {
    const at = document.querySelector("#write>p") ?? document.querySelector("#write") ?? document.body;
    displayMetrics = mj.getMetricsFor(at, true);
  }
  return displayMetrics;
}

export interface Rendered {
  /** `mjx-container` holding the SVG; clone it before inserting. */
  node: HTMLElement;
  /** Equation number the next block starts at. */
  next: number;
}

const cache = new Map<string, Rendered>();
const CACHE_LIMIT = 500;
let chain: Promise<unknown> = Promise.resolve();

/** Forget rendered formulas, so they render again. */
export function clearMathCache() {
  cache.clear();
}

/** Render TeX, numbering its equations from `start`. Results are cached. */
export function renderTex(tex: string, display: boolean, start = 1): Promise<Rendered> {
  const numbered = display && options.autoNumber;
  const key = `${display ? (numbered ? start : "d") : "i"}\0${tex}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last, so the oldest entries are evicted first.
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  const run = async (): Promise<Rendered> => {
    const mj = await load();
    const tags = mj.startup.input[0].parseOptions.tags;
    if (numbered) {
      // Labels stay defined across blocks, so \eqref reaches other blocks.
      const labels = tags.allLabels;
      mj.texReset(start - 1);
      mj.startup.input[0].parseOptions.tags.allLabels = labels;
    }
    const node = await mj.tex2svgPromise(tex, display ? metrics(mj) : { display: false });
    const next = numbered ? mj.startup.input[0].parseOptions.tags.counter + 1 : start;
    const out = { node, next };
    cache.set(key, out);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return out;
  };
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

/** Resolves once every formula asked for so far has rendered. */
export async function mathIdle(): Promise<void> {
  let seen: Promise<unknown>;
  do {
    seen = chain;
    await seen;
    // Views insert their result a microtask after it arrives, and may ask for more.
    await new Promise((done) => setTimeout(done));
  } while (seen !== chain);
}
