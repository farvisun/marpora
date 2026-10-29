// The sidebar's context menu (Typora's `#file-menu`): what a right click on a file, a
// folder or the files' empty space offers, with Typora's rules for which items show.

import { createSignal, For, onMount } from "solid-js";
import { type Backend, report } from "../ipc";
import { hideFileSearch, showFileSearch } from "./librarySearch";
import { setUi, ui } from "./store";

/** A new file waiting, across the reload that opens it, for its name to be typed. */
export const RENAME_KEY = "marpora.rename";

/** Create an untitled file (or folder) in `dir`, the sidebar's folder by default, and
 * let its name be typed in place. Typora opens a new file only in place of an empty,
 * unsaved document. */
export async function createLibraryFile(backend: Backend, onOpenFile: (path: string) => void, dir?: string, folder = false) {
  const path = await backend.newLibraryFile(dir, folder);
  setUi("libraryVersion", (v) => v + 1);
  setUi("renaming", path);
  if (!folder && ui.path === null && !ui.dirty) {
    sessionStorage.setItem(RENAME_KEY, path);
    onOpenFile(path);
  }
}

export interface FileMenuTarget {
  x: number;
  y: number;
  /** The file or folder clicked; the sidebar's folder for the tree's empty space. */
  path: string | null;
  isDirectory: boolean;
  /** The tree's root folder. */
  root: boolean;
  /** The tree's empty space, which only offers New File and New Folder. */
  emptyTree: boolean;
}

type Action =
  | "open"
  | "open_in_new_window"
  | "new_file"
  | "new_folder"
  | "search"
  | "list_view"
  | "tree_view"
  | "rename"
  | "duplicate"
  | "delete"
  | "copy_path"
  | "reveal"
  | "divider";

/** Typora's items, with the `for-*` attributes it shows and hides them by. */
const ITEMS: { action: Action; label?: string; on: ("file" | "folder" | "new" | "search")[] }[] = [
  { action: "open", label: "Open", on: ["file", "search"] },
  { action: "open_in_new_window", label: "Open in New Window", on: ["file", "search"] },
  { action: "open_in_new_window", label: "Open in New Window", on: ["folder"] },
  { action: "divider", on: ["file", "folder"] },
  { action: "new_file", label: "New File", on: ["new"] },
  { action: "new_folder", label: "New Folder", on: ["new"] },
  { action: "divider", on: ["search", "new"] },
  { action: "search", label: "Search", on: ["search"] },
  { action: "divider", on: [] },
  { action: "list_view", label: "Articles (List View)", on: [] },
  { action: "tree_view", label: "File Tree (Tree View)", on: [] },
  { action: "divider", on: [] },
  { action: "rename", label: "Rename", on: ["folder", "file"] },
  { action: "duplicate", label: "Duplicate", on: ["file"] },
  { action: "divider", on: ["folder", "file"] },
  { action: "delete", label: "Delete", on: ["folder", "file"] },
  { action: "divider", on: ["folder", "file", "search"] },
  { action: "copy_path", label: "Copy File Path", on: ["search"] },
  { action: "reveal", label: "Open File Location", on: ["search"] },
];

/** The items Typora shows for `t`, without doubled or dangling dividers. */
export function fileMenuItems(t: FileMenuTarget, tree: boolean) {
  const shown = ITEMS.filter((item) => {
    const has = (k: (typeof item.on)[number]) => item.on.includes(k);
    const fileOnly = has("file") && !has("folder");
    const folderOnly = has("folder") && !has("file");
    if (t.emptyTree) return item.action === "new_file" || item.action === "new_folder";
    if (tree) return t.root ? !has("file") : t.isDirectory ? !fileOnly : !folderOnly;
    if (item.action === "new_folder" || folderOnly) return false;
    // Nothing clicked in the list: nothing to act on.
    return !!t.path || !(has("file") || has("folder") || item.action === "copy_path" || item.action === "reveal");
  });
  return shown.filter(
    (item, i) => item.action !== "divider" || (i > 0 && i < shown.length - 1 && shown[i + 1].action !== "divider"),
  );
}

export function FileMenu(props: {
  target: FileMenuTarget;
  backend: Backend;
  onOpenFile(path: string): void;
  onClose(): void;
}) {
  let menu!: HTMLUListElement;
  const t = props.target;
  const [pos, setPos] = createSignal({ left: t.x, top: t.y });
  // Placed as Typora places it: kept 220px from the right and clear of the bottom.
  onMount(() => {
    const room = menu.offsetHeight + 48;
    setPos({ left: Math.min(t.x, innerWidth - 220), top: t.y > innerHeight - room ? innerHeight - room : t.y + 8 });
    menu.focus();
  });
  const bump = () => setUi("libraryVersion", (v) => v + 1);
  const folderOf = () => (!t.path || t.isDirectory ? (t.path ?? undefined) : t.path.slice(0, t.path.lastIndexOf("/")));
  const run = async (action: Action) => {
    const path = t.path;
    switch (action) {
      case "new_file":
        return createLibraryFile(props.backend, props.onOpenFile, folderOf());
      case "new_folder":
        return createLibraryFile(props.backend, props.onOpenFile, folderOf(), true);
      case "search":
        return ui.fileSearch.shown ? hideFileSearch() : showFileSearch();
      case "list_view":
      case "tree_view":
        return setUi("fileTree", action === "tree_view");
    }
    if (!path) return;
    switch (action) {
      case "open":
        return props.onOpenFile(path);
      case "open_in_new_window":
        return props.backend.openLibraryFileInWindow(path);
      case "rename":
        return setUi("renaming", path);
      case "duplicate": {
        const copy = await props.backend.duplicateLibraryFile(path);
        bump();
        // Typora switches to the copy of the open document.
        if (path === ui.path) props.onOpenFile(copy);
        return;
      }
      case "delete":
        await props.backend.trashLibraryFile(path);
        return bump();
      case "copy_path":
        return navigator.clipboard.writeText(path);
      case "reveal":
        return props.backend.revealLibraryFile(path);
    }
  };
  const on = (action: Action) =>
    (action === "list_view" && !ui.fileTree) || (action === "tree_view" && ui.fileTree) || (action === "search" && ui.fileSearch.shown);
  return (
    <ul
      ref={menu}
      id="file-menu"
      class="dropdown-menu context-menu ext-context-menu show"
      role="menu"
      tabindex="-1"
      style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
      onBlur={() => props.onClose()}
      onKeyDown={(e) => e.key === "Escape" && props.onClose()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <For each={fileMenuItems(t, ui.fileTree)}>
        {(item) =>
          item.action === "divider" ? (
            <li class="divider" />
          ) : (
            <li data-action={item.action} data-key>
              <a
                role="menuitem"
                classList={{ "state-on": on(item.action), "state-off": !on(item.action) }}
                // Items act on a left mousedown, as in Typora.
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  props.onClose();
                  void run(item.action).catch(report);
                }}
              >
                {item.label}
              </a>
            </li>
          )
        }
      </For>
    </ul>
  );
}
