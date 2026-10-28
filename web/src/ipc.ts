// The editor's view of the Rust core. In the Tauri app this is IPC; in a plain browser
// (vite dev without Tauri, tests) an in-memory backend stands in.

import { type Flavor, parseMarkdown } from "./md";

export interface Patch {
  baseVersion: number;
  start: number;
  delete: number;
  insert: string[];
}

/** An edit made outside the editor; `insert` is ProseMirror JSON. */
export interface RemotePatch {
  version: number;
  start: number;
  delete: number;
  insert: unknown[];
}

export interface OpenedDoc {
  id: number;
  path: string | null;
  text: string;
  version: number;
}

/** App preferences (src-tauri settings.rs). */
export interface Settings {
  theme: string;
  flavor: Flavor;
  /** Number display equations (read when a window opens, like the flavor). */
  autoNumberMath: boolean;
  /** Save documents that have a file shortly after each edit, and when they close. */
  autoSave: boolean;
  /** Keep copies of unsaved edits in the drafts folder. */
  backupUnsavedDrafts: boolean;
}

/** A theme's CSS (src-tauri themes.rs). `css` is null for themes bundled with the app. */
export interface ThemeCss {
  css: string | null;
  /** Directory relative `url()`s in `css` resolve against. */
  dir: string | null;
  /** User overrides as `[css, dir]`. */
  user: [string, string][];
}

/** A file or folder in the sidebar's file tree (src-tauri library.rs). */
export interface LibraryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hasChildren: boolean;
  /** Milliseconds since the epoch. */
  modified: number;
  created: number;
}

/** A Markdown file in the article list or Quick Open. */
export interface LibraryDoc {
  name: string;
  path: string;
  folder: string;
  modified: number;
  created: number;
  /** The start of the file (article list only). */
  summary: string;
}

export interface LibraryInfo {
  folder: string | null;
  /** The window was opened on a folder (File › Open Folder). */
  openedFolder: boolean;
  home: string | null;
}

export interface LibraryDocs {
  files: LibraryDoc[];
  /** The folder holds more files than were listed. */
  oversize: boolean;
}

export type PatchResult = { ok: true; version: number } | { ok: false; current: number };

export interface Backend {
  /** The document this window was opened with. */
  initialDocument(): Promise<OpenedDoc>;
  /** Open a file in its own window (or focus the window showing it). */
  openPath(path: string): Promise<void>;
  /** Open a file in this window when its document is saved, else in a new one. */
  openHere(path: string): Promise<void>;
  /** The folder the Files tab shows (the document's folder) and the home folder. */
  libraryInfo(): Promise<LibraryInfo>;
  /** One level of the file tree under the library folder. */
  listFolder(path: string): Promise<LibraryEntry[]>;
  /** Markdown files in the library folder, with summaries for the article list. */
  listDocuments(summaries: boolean): Promise<LibraryDocs>;
  /** Recently opened files, newest first. */
  recentFiles(): Promise<string[]>;
  applyPatch(docId: number, patch: Patch): Promise<PatchResult>;
  /** Full text, used to resynchronise after a rejected patch. */
  documentText(docId: number): Promise<{ text: string; version: number }>;
  /** Replace the whole text (source mode). Resolves to the new version. */
  setText(docId: number, text: string): Promise<number>;
  /** Save, asking for a path when needed. `null` when the user cancelled. */
  save(docId: number, saveAs: boolean): Promise<{ path: string; version: number } | null>;
  isDirty(docId: number): Promise<boolean>;
  onRemotePatch(handler: (docId: number, patch: RemotePatch) => void): void;
  /** The file changed on disk while the document had unsaved edits. */
  onDiskChanged(handler: (docId: number) => void): void;
  /** Replace the document with its file on disk, dropping unsaved edits. */
  reloadDocument(docId: number): Promise<void>;
  /** The user cancelled closing this window, so quitting the app stops. */
  cancelQuit(): Promise<void>;
  /** Resolve an image path relative to the document to a URL the webview can load. */
  assetUrl(docPath: string | null, src: string): string;
  settings(): Promise<Settings>;
  loadTheme(id: string): Promise<ThemeCss | null>;
  /** Switch every window to theme `id`; they hear about it through `onSettings`. */
  setTheme(id: string): Promise<void>;
  onSettings(handler: (settings: Settings) => void): void;
  /** Ask where to export the document as `format` (`extension`); `null` when cancelled. */
  exportPath(docId: number, format: string, extension: string): Promise<string | null>;
  /** Write an export to a path `exportPath` returned. */
  writeExport(path: string, contents: string): Promise<void>;
  /** Print the export page `html` to a PDF at a path `exportPath` returned. */
  exportPdf(path: string, html: string): Promise<void>;
  /** Print the export page `html` through the print panel. */
  print(html: string): Promise<void>;
  /** Export the saved-to-core text through Pandoc as `format` (`docx`, `latex`, ...). */
  exportPandoc(docId: number, format: string): Promise<boolean>;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function connect(): Promise<Backend> {
  if (inTauri) {
    const { TauriBackend } = await import("./ipc-tauri");
    return new TauriBackend();
  }
  return new MemoryBackend();
}

/** In-memory stand-in with the same block semantics as marpora-core's Document. */
export class MemoryBackend implements Backend {
  /** Top-level block sources, split from `text` when first needed. */
  private blocks: string[] | null = null;
  private version = 0;
  private saved = 0;
  private remote: ((id: number, p: RemotePatch) => void)[] = [];
  private settingsHandlers: ((s: Settings) => void)[] = [];
  private current: Settings = {
    theme: "marpora",
    flavor: { inlineMath: false, highlight: false, subscript: false, superscript: false },
    autoNumberMath: true,
    autoSave: false,
    backupUnsavedDrafts: true,
  };

  constructor(private text = DEMO) {}

  async initialDocument(): Promise<OpenedDoc> {
    return { id: 1, path: null, text: this.text, version: this.version };
  }

  async openPath(): Promise<void> {}

  /** Test hook: files opened with `openHere`. */
  opened: string[] = [];

  async openHere(path: string) {
    this.opened.push(path);
  }

  /** Test hook: a fake library folder, as path to text. */
  library: { root: string; files: Record<string, string>; recent: string[] } = { root: "", files: {}, recent: [] };

  async libraryInfo(): Promise<LibraryInfo> {
    return { folder: this.library.root || null, openedFolder: false, home: "/home/me" };
  }

  async listFolder(path: string): Promise<LibraryEntry[]> {
    const seen = new Map<string, LibraryEntry>();
    for (const file of Object.keys(this.library.files)) {
      if (!file.startsWith(`${path}/`)) continue;
      const [name, ...rest] = file.slice(path.length + 1).split("/");
      const isDirectory = rest.length > 0;
      if (!seen.has(name))
        seen.set(name, { name, path: `${path}/${name}`, isDirectory, hasChildren: isDirectory, modified: 0, created: 0 });
    }
    return [...seen.values()];
  }

  async listDocuments(summaries: boolean): Promise<LibraryDocs> {
    const files = Object.entries(this.library.files).map(([path, text], i) => {
      const cut = path.lastIndexOf("/");
      return {
        name: path.slice(cut + 1),
        path,
        folder: path.slice(0, cut),
        modified: Date.now() - i * 60_000,
        created: 0,
        summary: summaries ? text.slice(0, 600) : "",
      };
    });
    return { files, oversize: false };
  }

  async recentFiles() {
    return this.library.recent;
  }

  async applyPatch(_id: number, p: Patch): Promise<PatchResult> {
    if (p.baseVersion !== this.version) return { ok: false, current: this.version };
    this.blocks ??= splitBlocks(this.text);
    this.blocks.splice(p.start, p.delete, ...p.insert);
    this.text = this.blocks.join("\n\n") + "\n";
    this.version += 1;
    return { ok: true, version: this.version };
  }

  async documentText() {
    return { text: this.text, version: this.version };
  }

  async setText(_id: number, text: string) {
    this.text = text;
    this.blocks = null;
    this.version += 1;
    return this.version;
  }

  async save() {
    this.saved = this.version;
    return { path: "untitled.md", version: this.version };
  }

  async isDirty() {
    return this.saved !== this.version;
  }

  onRemotePatch(handler: (id: number, p: RemotePatch) => void) {
    this.remote.push(handler);
  }

  /** Test hook: simulate an edit by an agent. */
  pushRemote(patch: RemotePatch) {
    this.version = patch.version;
    for (const h of this.remote) h(1, patch);
  }

  private diskHandlers: ((id: number) => void)[] = [];
  /** Text "on disk" that changed while there were unsaved edits. */
  private disk: string | null = null;

  onDiskChanged(handler: (id: number) => void) {
    this.diskHandlers.push(handler);
  }

  /** Test hook: the file changed on disk, as watch.rs reports it. */
  async changeOnDisk(text: string) {
    this.disk = text;
    if (await this.isDirty()) for (const h of this.diskHandlers) h(1);
    else await this.reloadDocument();
  }

  async cancelQuit() {}

  async reloadDocument() {
    if (this.disk === null) return;
    const blocks = (this.blocks ??= splitBlocks(this.text)).length;
    this.text = this.disk;
    this.blocks = null;
    this.saved = this.version + 1;
    this.pushRemote({
      version: this.version + 1,
      start: 0,
      delete: blocks,
      insert: parseMarkdown(this.text).doc.toJSON().content ?? [],
    });
  }

  assetUrl(_docPath: string | null, src: string) {
    return src;
  }

  async settings() {
    try {
      const saved = JSON.parse(localStorage.getItem("marpora.settings") ?? "{}") as Partial<Settings>;
      this.current = { ...this.current, ...saved, flavor: { ...this.current.flavor, ...saved.flavor } };
    } catch {
      // Storage may be unavailable or hold junk; defaults apply.
    }
    return this.current;
  }

  async loadTheme(id: string): Promise<ThemeCss | null> {
    return id.includes("/") ? null : { css: null, dir: null, user: [] };
  }

  async setTheme(id: string) {
    this.current = { ...this.current, theme: id };
    try {
      localStorage.setItem("marpora.settings", JSON.stringify(this.current));
    } catch {
      // Not persisted; the theme still applies to this page.
    }
    for (const h of this.settingsHandlers) h(this.current);
  }

  onSettings(handler: (s: Settings) => void) {
    this.settingsHandlers.push(handler);
  }

  /** Test hook: exports written, by path. */
  exports = new Map<string, string>();

  async exportPath(_id: number, _format: string, extension: string) {
    return `/export/untitled.${extension}`;
  }

  async writeExport(path: string, contents: string) {
    this.exports.set(path, contents);
  }

  async exportPdf(path: string, html: string) {
    this.exports.set(path, html);
  }

  async print(html: string) {
    this.exports.set("print", html);
  }

  async exportPandoc(): Promise<boolean> {
    throw new Error("Pandoc export needs the desktop app.");
  }
}

function splitBlocks(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  return parseMarkdown(text).blocks.map(([s, e]) => decoder.decode(bytes.subarray(s, e)));
}

const DEMO = `# Welcome to Marpora

A **Typora-style** editor with *seamless* live preview. Edit \`inline code\`, ~~strike~~, ==highlight==, and [links](https://typora.io).

> Quotes, lists and tables work as you type.

- [ ] task
- [x] done

| Feature | Status |
| :------ | -----: |
| Tables  | ready  |

\`\`\`rust
fn main() {}
\`\`\`
`;
