// The editor's view of the Rust core. In the Tauri app this is IPC; in a plain browser
// (vite dev without Tauri, tests) an in-memory backend stands in.

import type { MenuContext } from "./editor/contextmenu";
import { type Flavor, parseMarkdown } from "./md";

/** A selection as agents see it: its text, and the top level blocks it spans. */
export interface AgentSelection {
  text: string;
  startBlock: number;
  endBlock: number;
}

/** A folder in the sidebar menu's Recent Locations. */
export interface RecentFolder {
  path: string;
  pinned: boolean;
}

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
  /** Keep File › Open Recent and Quick Open's recent files. */
  recordRecent: boolean;
  /** List dot files and folders in the sidebar. */
  showHiddenFiles: boolean;
  /** Quit when the last window closes instead of staying in the Dock. */
  quitOnLastWindowClosed: boolean;
  /** Sidebar order (chrome/library.ts `SortType`) for the article list and file tree. */
  listSort: number;
  treeSort: number;
  /** "Group By Folder" turned off: one sorted list, folders mixed with files. */
  listNoGroup: boolean;
  treeNoGroup: boolean;
  /** The sidebar Search's options. */
  fileSearchCaseSensitive: boolean;
  fileSearchWholeWord: boolean;
  fileSearchUseRegexp: boolean;
  /** View › Status Bar. */
  showStatusBar: boolean;
  /** Where pasted images go: "", "folder", "assets", "per-file-assets" or a path (src-tauri images.rs). */
  imageStorage: string;
  /** Refer to images in the document's folder by relative paths. */
  useRelativeImagePath: boolean;
  /** Edit › Line Endings › Insert Final New Line On Save. */
  insertFinalNewline: boolean;
  /** Edit › Whitespace and Line Breaks (editor/whitespace.ts): Typora's options. */
  indentFirstLine: boolean;
  /** "Visible <br/>" turned off. */
  hideBr: boolean;
  /** "Preserve single line break": soft breaks show as spaces. */
  ignoreLineBreak: boolean;
  /** Preferences › Export: the theme exports use ("" for the window's). */
  exportTheme: string;
  /** PDF and print: each top level heading starts a page. */
  exportPageBreak: boolean;
  /** HTML and PDF: extra HTML in `<head>` and at the end of `<body>`. */
  exportAppendHead: string;
  exportAppendBody: string;
  /** Image export: the page width. */
  exportImageWidth: number;
  /** Preferences › AI: "anthropic", "openai" (a compatible endpoint), "claude-code" or "codex". */
  aiProvider: string;
  /** The model; the provider's default when empty. */
  aiModel: string;
  /** The OpenAI-compatible endpoint, up to `/v1`. */
  aiBaseUrl: string;
}

/** A sidebar Search (src-tauri search.rs). */
export interface FileSearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export interface FileSearchResults {
  files: FileHit[];
  /** The query is not a valid regular expression. */
  error: string | null;
  /** More files matched than were listed. */
  more: boolean;
}

export interface FileHit {
  path: string;
  /** Matches in the lines found; 0 when only the file name matched. */
  total: number;
  lines: { line: number; text: string; ranges: [number, number][] }[];
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

/** A request to the AI model: a system prompt (stable, so it caches) and the conversation. */
export interface AiRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** "low", "medium" or "high"; the provider's default when empty. */
  effort?: string;
}

/** A streamed piece of an AI answer: more text, the whole answer, or an error. */
export interface AiEvent {
  id: number;
  text?: string;
  done?: string;
  error?: string;
}

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
  /** Recently opened folders, pinned ones first, then newest first (the sidebar menu's Recent Locations). */
  recentFolders(): Promise<RecentFolder[]>;
  /** Pin a recent folder to the top of Recent Locations, or unpin it. */
  pinRecentFolder(path: string, pinned: boolean): Promise<void>;
  /** Take a folder out of Recent Locations. */
  removeRecentFolder(path: string): Promise<void>;
  /** Create an untitled file, or folder, in `dir` (the library folder by default); returns its path. */
  newLibraryFile(dir?: string, folder?: boolean): Promise<string>;
  /** Copy a library file next to it as `name (copy).md`; returns the copy. */
  duplicateLibraryFile(path: string): Promise<string>;
  /** Move a library file or folder to the Trash. */
  trashLibraryFile(path: string): Promise<void>;
  /** Show a library file or folder selected in Finder. */
  revealLibraryFile(path: string): Promise<void>;
  /** Open a library file, or folder, in a new window. */
  openLibraryFileInWindow(path: string): Promise<void>;
  /** Rename `path`, in the library folder, to `name` in its folder; returns the new path. */
  renameLibraryFile(path: string, name: string): Promise<string>;
  /** The window's document moved (renamed in a sidebar); `path` is where it is now. */
  onPathChanged(handler: (path: string) => void): void;
  /** Show the window's document in Finder. */
  revealDocument(): Promise<void>;
  /** Move the window's document to the Trash. */
  trashDocument(): Promise<void>;
  /** Show (`reveal`), copy as image data (`copy`) or trash (`trash`) the local image file `src` names. */
  imageFileAction(src: string, action: "reveal" | "copy" | "trash"): Promise<void>;
  /** Copy (`keep`) or move the image file `src` names where the user picks; its new src, or null if cancelled. */
  relocateImage(src: string, keep: boolean): Promise<string | null>;
  /** Copy (`keep`) or move the image files `srcs` name into `dir`; each one's new src, or null. */
  relocateImages(srcs: string[], dir: string, keep: boolean): Promise<(string | null)[]>;
  /** A folder the user picks, starting in `dir`; null if cancelled. */
  pickFolder(dir?: string): Promise<string | null>;
  /** Put text (and HTML) on the system clipboard. */
  writeClipboard(text: string, html?: string): Promise<void>;
  /** The system clipboard's text. */
  readClipboard(): Promise<string | null>;
  /** What the editor's right click is on, for the native context menu. */
  setContextMenu(context: MenuContext): Promise<void>;
  /** The editor's selection, for agents (the MCP server's get_selection); null when empty. */
  reportSelection(docId: number, selection: AgentSelection | null): Promise<void>;
  /** Open a link from the document; returns the heading a `#…` link names. */
  openLink(href: string): Promise<string | null>;
  /** Store a pasted image (`ext`: png, jpg, ...) for document `docId`; returns its path for the document. */
  saveImage(docId: number, data: Uint8Array, ext: string): Promise<string>;
  /** Files dropped on the window from Finder, at a point in the page. */
  onFileDrop(handler: (paths: string[], x: number, y: number) => void): void;
  /** Show the library folder in Finder. */
  revealLibrary(): Promise<void>;
  /** Show recent folder `dir` in the sidebar, or one the user picks; false if cancelled. */
  switchLibraryFolder(dir?: string): Promise<boolean>;
  /** Find in the library folder's Markdown files (the sidebar's Search). */
  searchLibrary(query: FileSearchQuery): Promise<FileSearchResults>;
  /** Change some settings; every window hears about it through `onSettings`. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
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
  /** Start AI request `id`; its answer arrives through `onAi`. */
  aiStart(id: number, request: AiRequest): Promise<void>;
  /** Stop AI request `id`. */
  aiCancel(id: number): Promise<void>;
  onAi(handler: (event: AiEvent) => void): void;
  onSettings(handler: (settings: Settings) => void): void;
  /** Ask where to export the document as `format` (`extension`); `null` when cancelled. */
  exportPath(docId: number, format: string, extension: string): Promise<string | null>;
  /** Write an export to a path `exportPath` returned. */
  writeExport(path: string, contents: string): Promise<void>;
  /** Print the export page `html` to a PDF at a path `exportPath` returned. */
  exportPdf(path: string, html: string): Promise<void>;
  /** A slide deck's page as a PDF, one `width` × `height` (CSS pixels) slide a page. */
  exportSlidesPdf(path: string, html: string, width: number, height: number): Promise<void>;
  /** Save the export page `html`, all of it, as a PNG image at a path `exportPath` returned. */
  exportImage(path: string, html: string): Promise<void>;
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
    recordRecent: true,
    showHiddenFiles: false,
    quitOnLastWindowClosed: false,
    listSort: 0,
    treeSort: 0,
    listNoGroup: false,
    treeNoGroup: false,
    fileSearchCaseSensitive: false,
    fileSearchWholeWord: false,
    fileSearchUseRegexp: false,
    showStatusBar: true,
    imageStorage: "",
    useRelativeImagePath: true,
    insertFinalNewline: false,
    indentFirstLine: false,
    hideBr: false,
    ignoreLineBreak: false,
    exportTheme: "",
    exportPageBreak: false,
    exportAppendHead: "",
    exportAppendBody: "",
    exportImageWidth: 640,
    aiProvider: "anthropic",
    aiModel: "",
    aiBaseUrl: "",
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
  library: { root: string; files: Record<string, string>; recent: string[]; folders: string[] } = {
    root: "",
    files: {},
    recent: [],
    folders: [],
  };
  /** Test hook: library actions taken. */
  libraryLog: string[] = [];

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
        created: i,
        summary: summaries ? text.slice(0, 600) : "",
      };
    });
    return { files, oversize: false };
  }

  async recentFiles() {
    return this.library.recent;
  }

  pinned: string[] = [];
  async recentFolders() {
    const pinned = this.pinned.filter((p) => this.library.folders.includes(p));
    return [
      ...pinned.map((path) => ({ path, pinned: true })),
      ...this.library.folders.filter((p) => !pinned.includes(p)).map((path) => ({ path, pinned: false })),
    ];
  }
  async pinRecentFolder(path: string, pinned: boolean) {
    this.pinned = this.pinned.filter((p) => p !== path);
    if (pinned) this.pinned.unshift(path);
  }
  async removeRecentFolder(path: string) {
    this.library.folders = this.library.folders.filter((p) => p !== path);
    this.pinned = this.pinned.filter((p) => p !== path);
  }

  async newLibraryFile(dir = this.library.root, folder = false) {
    let n = 0;
    const name = () => `${dir}/Untitled${folder ? " Folder" : ""}${n ? ` ${n}` : ""}${folder ? "" : ".md"}`;
    while (name() in this.library.files) n++;
    if (folder) this.libraryLog.push(`mkdir ${name()}`);
    else this.library.files[name()] = "";
    return name();
  }

  async duplicateLibraryFile(path: string) {
    const copy = path.replace(/(\.[^./]*)?$/, " (copy)$1");
    this.library.files[copy] = this.library.files[path] ?? "";
    this.libraryLog.push(`duplicate ${path}`);
    return copy;
  }

  async trashLibraryFile(path: string) {
    for (const p of Object.keys(this.library.files)) if (p === path || p.startsWith(`${path}/`)) delete this.library.files[p];
    this.libraryLog.push(`trash ${path}`);
  }

  async revealLibraryFile(path: string) {
    this.libraryLog.push(`reveal ${path}`);
  }

  async openLibraryFileInWindow(path: string) {
    this.libraryLog.push(`window ${path}`);
  }

  async renameLibraryFile(path: string, name: string) {
    const to = `${path.slice(0, path.lastIndexOf("/"))}/${name.replace(/[/\\]/g, "").trim()}`;
    if (to !== path && to in this.library.files) throw new Error("File with same name already exists at target path.");
    this.library.files = Object.fromEntries(Object.entries(this.library.files).map(([p, t]) => [p === path ? to : p, t]));
    this.libraryLog.push(`rename ${path} ${to}`);
    return to;
  }

  onPathChanged(_handler: (path: string) => void) {}

  async revealDocument() {}
  imageLog: string[] = [];
  async imageFileAction(src: string, action: "reveal" | "copy" | "trash") {
    this.imageLog.push(`${action} ${src}`);
  }
  /** What the next relocateImage returns (the mock has no dialog). */
  relocateTo: string | null = null;
  async relocateImage(src: string, keep: boolean) {
    this.imageLog.push(`${keep ? "copy" : "move"} ${src}`);
    return this.relocateTo;
  }
  async relocateImages(srcs: string[], dir: string, keep: boolean) {
    this.imageLog.push(`${keep ? "copy" : "move"} ${srcs.join(" ")} to ${dir}`);
    return srcs.map((s) => (/^[a-z]+:/.test(s) ? null : `${dir}/${s.slice(s.lastIndexOf("/") + 1)}`));
  }
  /** What the next pickFolder returns (the mock has no dialog). */
  pickedFolder: string | null = null;
  async pickFolder() {
    return this.pickedFolder;
  }

  /** Test hook: whether the document went to the Trash. */
  trashed = false;

  async trashDocument() {
    this.trashed = true;
  }

  /** Test hook: the clipboard. */
  clipboard: { text: string; html?: string } = { text: "" };

  async writeClipboard(text: string, html?: string) {
    this.clipboard = { text, html };
  }

  async readClipboard() {
    return this.clipboard.text;
  }

  /** Test hook: the last context menu context. */
  contextMenu: MenuContext | null = null;
  /** Test hook: the selection last reported for agents. */
  selection: AgentSelection | null = null;
  async reportSelection(_docId: number, selection: AgentSelection | null) {
    this.selection = selection;
  }

  async setContextMenu(context: MenuContext) {
    this.contextMenu = context;
  }

  /** Test hook: links opened. */
  links: string[] = [];

  async openLink(href: string) {
    this.links.push(href);
    return href.startsWith("#") ? decodeURIComponent(href.slice(1)) : null;
  }

  /** Test hook: pasted images, as path to size. */
  images = new Map<string, number>();

  async saveImage(_docId: number, data: Uint8Array, ext: string) {
    const path = `/images/image-${this.images.size + 1}.${ext}`;
    this.images.set(path, data.length);
    return path;
  }

  onFileDrop(_handler: (paths: string[], x: number, y: number) => void) {}

  async revealLibrary() {
    this.libraryLog.push("reveal");
  }

  async switchLibraryFolder(dir?: string) {
    if (!dir) return false;
    this.library.root = dir;
    this.libraryLog.push("switch " + dir);
    return true;
  }

  async searchLibrary(q: FileSearchQuery): Promise<FileSearchResults> {
    const escaped = q.regexp ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let pattern: RegExp;
    try {
      pattern = new RegExp(q.wholeWord ? `\\b${escaped}\\b` : escaped, q.caseSensitive ? "g" : "gi");
    } catch (e) {
      return { files: [], error: String(e), more: false };
    }
    const files: FileHit[] = [];
    for (const [path, text] of Object.entries(this.library.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const lines = text
        .split("\n")
        .map((line, i) => ({ line: i, text: line, ranges: [...line.matchAll(pattern)].map((m): [number, number] => [m.index, m.index + m[0].length]) }))
        .filter((l) => l.ranges.length)
        .slice(0, 21);
      const total = lines.reduce((n, l) => n + l.ranges.length, 0);
      pattern.lastIndex = 0;
      if (lines.length) files.push({ path, total, lines });
      else if (!q.regexp && pattern.test(path.slice(path.lastIndexOf("/") + 1)))
        files.push({ path, total: 0, lines: [{ line: 0, text: text.split("\n")[0], ranges: [] }] });
      pattern.lastIndex = 0;
    }
    return { files, error: null, more: false };
  }

  async updateSettings(patch: Partial<Settings>) {
    this.current = { ...this.current, ...patch };
    for (const h of this.settingsHandlers) h(this.current);
    return this.current;
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

  private aiHandlers: ((e: AiEvent) => void)[] = [];
  private aiCancelled = new Set<number>();
  /** Test hook: AI requests made, and the answers to give (else an echo); an answer
   * starting `error:` fails with the rest. */
  aiRequests: AiRequest[] = [];
  aiReplies: string[] = [];
  async aiStart(id: number, request: AiRequest) {
    this.aiRequests.push(request);
    const answer = this.aiReplies.shift() ?? `AI: ${request.messages.at(-1)?.content ?? ""}`;
    const send = (e: AiEvent) => !this.aiCancelled.has(id) && this.aiHandlers.forEach((h) => h(e));
    if (answer.startsWith("error:")) return void setTimeout(() => send({ id, error: answer.slice(6) }), 10);
    // In pieces, as a model streams.
    const pieces = answer.match(/[\s\S]{1,8}/g) ?? [];
    pieces.forEach((text, i) => setTimeout(() => send({ id, text }), 10 * (i + 1)));
    setTimeout(() => send({ id, done: answer }), 10 * (pieces.length + 1));
  }
  async aiCancel(id: number) {
    this.aiCancelled.add(id);
  }
  onAi(handler: (e: AiEvent) => void) {
    this.aiHandlers.push(handler);
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

  async exportSlidesPdf(path: string, html: string, width: number, height: number) {
    this.exports.set(path, `slides ${width}x${height}\n${html}`);
  }

  async exportPdf(path: string, html: string) {
    this.exports.set(path, html);
  }

  async exportImage(path: string, html: string) {
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

/** Log an error to the console and, in the app, to its log. */
export function report(e: unknown) {
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(e);
  if (inTauri) {
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("frontend_log", { message }));
  }
}
