import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { MenuContext } from "./editor/contextmenu";
import type {
  AgentSelection,
  RecentFolder,
  Backend,
  FileSearchQuery,
  FileSearchResults,
  LibraryDocs,
  LibraryEntry,
  LibraryInfo,
  OpenedDoc,
  Patch,
  PatchResult,
  RemotePatch,
  Settings,
  ThemeCss,
} from "./ipc";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Directory part of a path, keeping the trailing separator. */
function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i + 1) : "";
}

/** Resolve `.` and `..` segments in an absolute POSIX path. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return "/" + out.join("/");
}

export class TauriBackend implements Backend {
  initialDocument() {
    return invoke<OpenedDoc>("initial_document");
  }

  openPath(path: string) {
    return invoke<void>("open_path", { path });
  }

  openHere(path: string) {
    return invoke<void>("open_here", { path });
  }

  libraryInfo() {
    return invoke<LibraryInfo>("library_info");
  }

  listFolder(path: string) {
    return invoke<LibraryEntry[]>("list_folder", { path });
  }

  listDocuments(summaries: boolean) {
    return invoke<LibraryDocs>("list_documents", { summaries });
  }

  recentFiles() {
    return invoke<string[]>("recent_files");
  }

  recentFolders() {
    return invoke<RecentFolder[]>("recent_folders");
  }

  pinRecentFolder(path: string, pinned: boolean) {
    return invoke<void>("pin_recent_folder", { path, pinned });
  }

  removeRecentFolder(path: string) {
    return invoke<void>("remove_recent_folder", { path });
  }

  newLibraryFile(dir?: string, folder?: boolean) {
    return invoke<string>("new_library_file", { dir, folder });
  }

  duplicateLibraryFile(path: string) {
    return invoke<string>("duplicate_library_file", { path });
  }

  trashLibraryFile(path: string) {
    return invoke<void>("trash_library_file", { path });
  }

  revealLibraryFile(path: string) {
    return invoke<void>("reveal_library_file", { path });
  }

  openLibraryFileInWindow(path: string) {
    return invoke<void>("open_library_file_in_window", { path });
  }

  renameLibraryFile(path: string, name: string) {
    return invoke<string>("rename_library_file", { path, name });
  }

  revealDocument() {
    return invoke<void>("reveal_document");
  }

  imageFileAction(src: string, action: "reveal" | "copy" | "trash") {
    return invoke<void>("image_file_action", { src, action });
  }

  relocateImage(src: string, keep: boolean) {
    return invoke<string | null>("relocate_image", { src, keep });
  }

  relocateImages(srcs: string[], dir: string, keep: boolean) {
    return invoke<(string | null)[]>("relocate_images", { srcs, dir, keep });
  }

  async pickFolder(dir?: string) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, defaultPath: dir });
    return typeof picked === "string" ? picked : null;
  }

  trashDocument() {
    return invoke<void>("trash_document");
  }

  reportSelection(docId: number, selection: AgentSelection | null) {
    return invoke<void>("report_selection", { docId, selection });
  }

  setContextMenu(context: MenuContext) {
    return invoke<void>("set_context_menu", { context });
  }

  writeClipboard(text: string, html?: string) {
    return invoke<void>("write_clipboard", { text, html: html ?? null });
  }

  readClipboard() {
    return invoke<string | null>("read_clipboard");
  }

  openLink(href: string) {
    return invoke<string | null>("open_link", { href });
  }

  saveImage(docId: number, data: Uint8Array, ext: string) {
    return invoke<string>("save_image", data, { headers: { "x-doc-id": String(docId), "x-ext": ext } });
  }

  onFileDrop(handler: (paths: string[], x: number, y: number) => void) {
    void getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop") return;
      // Physical pixels from the window's corner; the page measures in CSS pixels.
      const scale = window.devicePixelRatio || 1;
      handler(e.payload.paths, e.payload.position.x / scale, e.payload.position.y / scale);
    });
  }

  onPathChanged(handler: (path: string) => void) {
    void getCurrentWebviewWindow().listen<string>("path-changed", (e) => handler(e.payload));
  }

  revealLibrary() {
    return invoke<void>("reveal_library");
  }

  searchLibrary(query: FileSearchQuery) {
    return invoke<FileSearchResults>("search_library", { query });
  }

  switchLibraryFolder(dir?: string) {
    return invoke<boolean>("switch_library_folder", { dir: dir ?? null });
  }

  updateSettings(patch: Partial<Settings>) {
    return invoke<Settings>("update_settings", { patch });
  }

  applyPatch(docId: number, patch: Patch) {
    return invoke<PatchResult>("apply_patch", { docId, patch });
  }

  documentText(docId: number) {
    return invoke<{ text: string; version: number }>("document_text", { docId });
  }

  setText(docId: number, text: string) {
    return invoke<number>("set_document_text", { docId, text });
  }

  save(docId: number, saveAs: boolean) {
    return invoke<{ path: string; version: number } | null>("save_document", { docId, saveAs });
  }

  isDirty(docId: number) {
    return invoke<boolean>("is_dirty", { docId });
  }

  onRemotePatch(handler: (docId: number, patch: RemotePatch) => void) {
    void getCurrentWebviewWindow().listen<{ docId: number; patch: RemotePatch }>("remote-patch", (e) =>
      handler(e.payload.docId, e.payload.patch),
    );
  }

  onDiskChanged(handler: (docId: number) => void) {
    void getCurrentWebviewWindow().listen<{ docId: number }>("disk-changed", (e) => handler(e.payload.docId));
  }

  reloadDocument(docId: number) {
    return invoke<void>("reload_document", { docId });
  }

  cancelQuit() {
    return invoke<void>("cancel_quit");
  }

  assetUrl(docPath: string | null, src: string): string {
    if (src.startsWith("file://")) return convertFileSrc(decodeURI(src.slice(7)));
    if (URL_SCHEME.test(src)) return src;
    let path = decodeURI(src);
    if (!path.startsWith("/")) {
      if (!docPath) return src;
      path = dirname(docPath) + path;
    }
    return convertFileSrc(normalize(path));
  }

  settings() {
    return invoke<Settings>("get_settings");
  }

  loadTheme(id: string) {
    return invoke<ThemeCss | null>("load_theme", { id });
  }

  setTheme(id: string) {
    return invoke<void>("set_theme", { id });
  }

  exportPath(docId: number, format: string, extension: string) {
    return invoke<string | null>("export_path", { docId, format, extension });
  }

  writeExport(path: string, contents: string) {
    return invoke<void>("write_export", { path, contents });
  }

  exportPdf(path: string, html: string) {
    return invoke<void>("export_pdf", { path, html });
  }

  exportImage(path: string, html: string) {
    return invoke<void>("export_image", { path, html });
  }

  print(html: string) {
    return invoke<void>("print_page_html", { html });
  }

  exportPandoc(docId: number, format: string) {
    return invoke<boolean>("export_pandoc", { docId, format });
  }

  onSettings(handler: (settings: Settings) => void) {
    void getCurrentWebviewWindow().listen<Settings>("settings", (e) => handler(e.payload));
  }
}
