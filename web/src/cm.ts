// CodeMirror 5, as in Typora: its tokenizer highlights code fences and its editor runs
// source mode, so themes' `.cm-*` rules apply unchanged.
//
// CM5 modes find the library and each other through the global `CodeMirror`, so every
// file runs as a classic script, after the files its AMD `define([...])` lists.

export interface ModeInfo {
  name: string;
  mime?: string;
  mode: string;
}

export interface CodeMirrorStatic {
  (host: HTMLElement, options: Record<string, unknown>): CodeMirrorEditor;
  runMode(text: string, mode: unknown, callback: (text: string, style: string | null) => void): void;
  findModeByName(name: string): ModeInfo | undefined;
  findModeByExtension(ext: string): ModeInfo | undefined;
  modes: Record<string, unknown>;
}

export interface CodeMirrorEditor {
  getValue(): string;
  setValue(text: string): void;
  getCursor(): { line: number; ch: number };
  setCursor(line: number, ch?: number): void;
  scrollIntoView(pos: CodeMirrorPos | { from: CodeMirrorPos; to: CodeMirrorPos } | null, margin?: number): void;
  focus(): void;
  refresh(): void;
  on(event: string, handler: (...args: never[]) => void): void;
  getWrapperElement(): HTMLElement;
  clearHistory(): void;
  undo(): void;
  redo(): void;
  execCommand(name: string): void;
  posFromIndex(index: number): CodeMirrorPos;
  indexFromPos(pos: CodeMirrorPos): number;
  markText(from: CodeMirrorPos, to: CodeMirrorPos, options: { className: string }): { clear(): void };
  setSelection(anchor: CodeMirrorPos, head?: CodeMirrorPos, options?: { scroll?: boolean }): void;
  getSelection(): string;
  replaceRange(text: string, from: CodeMirrorPos, to?: CodeMirrorPos, origin?: string): void;
  operation<T>(fn: () => T): T;
  off(event: string, handler: (...args: never[]) => void): void;
  getLine(line: number): string;
  lineCount(): number;
  findWordAt(pos: CodeMirrorPos): { anchor: CodeMirrorPos; head: CodeMirrorPos };
  replaceSelection(text: string, select?: "around" | "start"): void;
}

export interface CodeMirrorPos {
  line: number;
  ch: number;
}

const ROOT = "/node_modules/codemirror/";

const urls = import.meta.glob(
  [
    "/node_modules/codemirror/lib/codemirror.js",
    "/node_modules/codemirror/mode/meta.js",
    "/node_modules/codemirror/addon/runmode/runmode.js",
    "/node_modules/codemirror/addon/mode/*.js",
    "/node_modules/codemirror/addon/selection/active-line.js",
    "/node_modules/codemirror/mode/*/*.js",
  ],
  // Eager: only the URL strings land in the bundle; the files load on demand.
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

const scripts = new Map<string, Promise<void>>();

/** Resolve `../xml/xml` against `mode/markdown/markdown` → `mode/xml/xml`. */
function resolve(from: string, rel: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Run `path` (relative to the package, without `.js`) after its dependencies. */
function load(path: string): Promise<void> {
  let done = scripts.get(path);
  if (done) return done;
  done = (async () => {
    const url = urls[`${ROOT}${path}.js`];
    if (!url) throw new Error(`CodeMirror file not found: ${path}`);
    const src = await (await fetch(url)).text();
    const deps = src.match(/define\(\[([^\]]*)\]/)?.[1] ?? "";
    for (const dep of deps.matchAll(/"([^"]+)"/g)) await load(resolve(path, dep[1]));
    const script = document.createElement("script");
    script.text = `${src}\n//# sourceURL=${ROOT}${path}.js`;
    document.head.append(script);
    script.remove();
  })();
  scripts.set(path, done);
  return done;
}

let core: Promise<CodeMirrorStatic> | null = null;

/** The library with mode metadata and `runMode`. */
export function codemirror(): Promise<CodeMirrorStatic> {
  core ??= (async () => {
    await load("lib/codemirror");
    await Promise.all([load("mode/meta"), load("addon/runmode/runmode")]);
    return (window as unknown as { CodeMirror: CodeMirrorStatic }).CodeMirror;
  })();
  return core;
}

/** Mode info for a fence's language (`js`, `C++`, `sh`, `rs`…), if CodeMirror has one. */
export function modeInfo(cm: CodeMirrorStatic, lang: string): ModeInfo | undefined {
  const l = lang.trim();
  if (!l) return undefined;
  return cm.findModeByName(l) ?? cm.findModeByExtension(l.toLowerCase());
}

/** Load the mode for `info`; resolves to the spec to pass to CodeMirror. */
export async function loadMode(info: ModeInfo): Promise<string> {
  if (info.mode !== "null") await load(`mode/${info.mode}/${info.mode}`);
  return info.mime ?? info.mode;
}

/** Load an addon such as `selection/active-line`. */
export function loadAddon(path: string): Promise<void> {
  return load(`addon/${path}`);
}
