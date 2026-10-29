// The sidebar with Typora's macOS markup: one tab title at a time (Outline, Articles or
// Files) with a button to switch, the outline as nested lists, and the document's
// folder as an article list (the default) or a file tree. Themes style these ids and
// classes, so they follow Typora's.

import { createEffect, createMemo, createSignal, For, type JSX, on, onMount, Show } from "solid-js";
import { type Backend, type LibraryDoc, type LibraryEntry, type LibraryInfo, type RecentFolder, report } from "../ipc";
import {
  abbreviate,
  basename,
  groupByFolder,
  naturalDate,
  SortType,
  sortEntries,
  splitName,
  summaryLines,
  summaryOf,
} from "./library";
import { createLibraryFile, FileMenu, type FileMenuTarget, RENAME_KEY } from "./FileMenu";
import { FileSearchResults, FileSearchTabs, SearchIcon } from "./FileSearch";
import {
  hideFileSearch,
  hideOutlineFilter,
  outlineFilterPattern,
  saveFileSearch,
  showFileSearch,
  showOutlineFilter,
} from "./librarySearch";
import { librarySortOf, type OutlineItem, saveSidebar, setUi, ui } from "./store";

export interface SidebarProps {
  backend: Backend;
  onOutlineClick(pos: number): void;
  onOpenFile(path: string): void;
  /** Open a search result's file at zero-based source line `line`. */
  onOpenMatch(path: string, line: number): void;
  /** The editor's selection, to search for. */
  selectedText(): string;
}

/** A heading with the headings under it, as Typora nests the outline. */
interface OutlineNode {
  item: OutlineItem;
  index: number;
  children: OutlineNode[];
}

export function outlineTree(items: OutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  items.forEach((item, index) => {
    const node = { item, index, children: [] };
    while (stack.length && stack[stack.length - 1].item.level >= item.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

type ListState = "" | "rendering" | "complete" | "oversize";

export function Sidebar(props: SidebarProps) {
  const [info, setInfo] = createSignal<LibraryInfo | null>(null);
  const [list, setList] = createSignal<{ state: ListState; files: LibraryDoc[] }>({ state: "", files: [] });
  const filesShown = () => ui.sidebar && ui.sidebarTab === "files";
  const folder = () => info()?.folder ?? null;
  const shortPath = (path: string) => abbreviate(path, info()?.home ?? null);

  createEffect(() => saveSidebar());
  // A new file reloads the window to open it; its rename starts once it is back.
  const pending = sessionStorage.getItem(RENAME_KEY);
  sessionStorage.removeItem(RENAME_KEY);
  if (pending && pending === ui.path) setUi("renaming", pending);
  const [fileMenu, setFileMenu] = createSignal<FileMenuTarget | null>(null);
  /** Right click: on a tree row or list item, its menu; on the tree's empty space,
   * New File and New Folder for the sidebar's folder. */
  const openFileMenu = (e: MouseEvent) => {
    e.preventDefault();
    const target = e.target as Element;
    const row = target.closest(".file-node-content, .file-list-item");
    const node = row?.closest<HTMLElement>(".file-library-node");
    if (ui.fileTree && !node) {
      const dir = folder();
      if (dir) setFileMenu({ x: e.clientX, y: e.clientY, path: dir, isDirectory: true, root: true, emptyTree: true });
      return;
    }
    setFileMenu({
      x: e.clientX,
      y: e.clientY,
      path: node?.dataset.path ?? null,
      isDirectory: node?.dataset.isDirectory === "true",
      root: !!node?.classList.contains("file-node-root"),
      emptyTree: false,
    });
  };
  /** Finish an inline rename; `name` is null when cancelled. */
  const rename = async (path: string, name: string | null) => {
    setUi("renaming", null);
    if (name === null) return;
    try {
      if ((await props.backend.renameLibraryFile(path, name)) !== path) setUi("libraryVersion", (v) => v + 1);
    } catch (e) {
      report(e);
    }
  };
  createEffect(() => saveFileSearch());
  // Typora closes the search when the Outline tab shows.
  createEffect(
    on(
      () => ui.sidebarTab,
      (tab) => (tab === "outline" ? hideFileSearch() : hideOutlineFilter()),
      { defer: true },
    ),
  );

  // The folder follows the document (Save As can move it); load it when first shown.
  createEffect(
    on([filesShown, () => ui.path], ([shown]) => {
      if (shown) void props.backend.libraryInfo().then(setInfo);
    }),
  );
  createEffect(
    on([filesShown, () => ui.fileTree, folder, () => list().state], ([shown, tree, dir, state]) => {
      if (!shown || tree || state || info() === null) return;
      if (!dir) return setList({ state: "complete", files: [] });
      setList({ state: "rendering", files: [] });
      void props.backend
        .listDocuments(true)
        .then((docs) => setList({ state: docs.oversize ? "oversize" : "complete", files: docs.files }))
        .catch(() => setList({ state: "complete", files: [] }));
    }),
  );
  // A different folder, or different settings, list again.
  createEffect(on([folder, () => ui.libraryVersion], () => setList({ state: "", files: [] }), { defer: true }));
  const treeRoot = createMemo(
    () => {
      const dir = folder();
      return ui.fileTree && filesShown() && dir ? { dir, version: ui.libraryVersion } : null;
    },
    null,
    { equals: (a, b) => a?.dir === b?.dir && a?.version === b?.version },
  );

  const groups = () => groupByFolder(list().files, ui.librarySort.listSort, ui.librarySort.listNoGroup);
  const showFolderNames = () => list().files.some((f) => f.folder !== folder());
  const listChildren = (path: string) => props.backend.listFolder(path);

  const switchTab = () => setUi("sidebarTab", ui.sidebarTab === "files" ? "outline" : "files");
  const switchHint = () =>
    ui.sidebarTab === "files" ? "Switch to Outline view" : ui.fileTree ? "Switch to File Tree view" : "Switch to File List view";

  return (
    <div
      id="typora-sidebar"
      class="stopselect sidebar-menu"
      classList={{
        "active-tab-files": ui.sidebarTab === "files",
        "active-tab-outline": ui.sidebarTab === "outline",
        "use-file-tree-style": ui.fileTree,
        "use-file-list-style": !ui.fileTree,
        "ty-no-mount-folder": info() !== null && !folder(),
        "ty-show-search": ui.fileSearch.shown,
        "ty-on-search": ui.fileSearch.query !== null,
        "ty-show-outline-filter": ui.outlineFilter.shown,
        "ty-on-outline-filter": outlineFilterPattern() !== null,
      }}
      aria-hidden={!ui.sidebar}
    >
      <div class="sidebar-osx-tab ty-tab-wrapper">
        <div class="sidebar-tabs">
          <div class="sidebar-tab-btn" id="switch-sidebar-icon" onClick={switchTab}>
            <span class="ty-icon" ty-hint={switchHint()} aria-label={switchHint()}>
              {ui.sidebarTab === "files" ? <ListIcon /> : ui.fileTree ? <TreeIcon /> : <CellsIcon />}
            </span>
          </div>
          <div
            class="sidebar-tab"
            id="sidepanel-segmented-input-files"
            classList={{ active: ui.sidebarTab === "files" }}
            onClick={() => setUi("sidebarTab", "files")}
          >
            {ui.fileTree ? "Files" : "Articles"}
          </div>
          <div
            class="sidebar-tab"
            id="sidepanel-segmented-input-outline"
            classList={{ active: ui.sidebarTab === "outline" }}
            onClick={() => setUi("sidebarTab", "outline")}
          >
            Outline
          </div>
          <div class="sidebar-tab-btn" id="sidebar-search-btn" ty-hint="Search" onClick={() => (ui.sidebarTab === "outline" ? showOutlineFilter() : showFileSearch(props.selectedText()))}
          >
            <span class="ion-ios7-search-strong" aria-label="Search">
              <SearchIcon />
            </span>
          </div>
        </div>
        <FileSearchTabs backend={props.backend} />
      </div>
      <div class="sidebar-content" id="sidebar-content">
        <FileSearchResults folder={folder()} onOpenFile={props.onOpenFile} onOpenMatch={props.onOpenMatch} />
        <div id="outline-content" class="outline-content sidebar-content-content" data-after-content="Outline is Empty.">
          <For each={outlineTree(ui.outline)}>
            {(node) => <OutlineEntry node={node} onClick={props.onOutlineClick} />}
          </For>
        </div>
        <div id="file-library" class="sidebar-content-content" onContextMenu={openFileMenu}>
          <div
            id="file-library-tree"
            class="no-selection"
            data-after-content="No Folder is Opened."
            data-state={ui.fileTree && filesShown() && info() === null ? "rendering" : "complete"}
            tabindex="0"
          >
            <Show when={treeRoot()} keyed>
              {({ dir }) => (
                <TreeNode
                  entry={{ name: basename(dir), path: dir, isDirectory: true, hasChildren: true, modified: 0, created: 0 }}
                  root
                  list={listChildren}
                  title={shortPath}
                  onOpenFile={props.onOpenFile}
                  onRename={rename}
                />
              )}
            </Show>
          </div>
          <div id="file-library-list" class="no-selection" data-state={list().state} tabindex="0">
            <div id="sidebar-loading-template" class="file-list-item">
              <div class="sidebar-loading">
                <div class="typora-quick-open-info">
                  <span>Loading</span>
                </div>
                <Spinner />
              </div>
              <div class="oversize-list-template">
                <div>
                  Selected folders contains too many files. Please switch to{" "}
                  <a id="switch-to-tree-on-oversize" onClick={() => setUi("fileTree", true)}>
                    File Tree view
                  </a>{" "}
                  for better performance.
                </div>
              </div>
            </div>
            <div
              id="file-library-list-children"
              data-after-content="No Files Available"
              classList={{ "show-folder-name": showFolderNames() }}
            >
              <For each={groups()}>
                {(group) => (
                  <For each={group.files}>
                    {(file) => <ListItem file={file} title={shortPath} onOpenFile={props.onOpenFile} onRename={rename} />}
                  </For>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
      <Show when={fileMenu()} keyed>
        {(target) => (
          <FileMenu target={target} backend={props.backend} onOpenFile={props.onOpenFile} onClose={() => setFileMenu(null)} />
        )}
      </Show>
      <SidebarFooter
        backend={props.backend}
        folder={folder()}
        title={shortPath}
        onOpenFile={props.onOpenFile}
        onFolderChanged={() => {
          setUi("libraryVersion", (v) => v + 1);
          void props.backend.libraryInfo().then(setInfo);
        }}
      />
    </div>
  );
}

/** One of the menu's sort buttons: its two orders, and its hint without the direction. */
const SORT_BUTTONS = [
  { id: "ty-sort-by-natural-btn", asc: SortType.Natural, desc: SortType.NaturalDescend, hint: "Sort Naturally", icon: NaturalSortIcon },
  { id: "ty-sort-by-name-btn", asc: SortType.Alphabet, desc: SortType.AlphabetDescend, hint: "Sort by Name", icon: NameSortIcon },
  { id: "ty-sort-by-date-btn", asc: SortType.Date, desc: SortType.DateDescend, hint: "Sort by Modification Date", icon: DateSortIcon },
  { id: "ty-sort-by-create-btn", asc: SortType.CreateDate, desc: SortType.CreateDateDescend, hint: "Sort by Creation Date", icon: CreatedSortIcon },
];

/** Typora's limit on recent folders in the menu, which also must fit above it. */
const MAX_RECENT_FOLDERS = 6;

/** The Files tab's footer: New File, the folder's menu (actions, sorting and recent
 * folders) and the list/tree switch. Typora opens the menu on mousedown and closes it
 * when it loses focus, which choosing an item does; sort buttons keep it open. */
function SidebarFooter(props: {
  backend: Backend;
  folder: string | null;
  title(path: string): string;
  onOpenFile(path: string): void;
  onFolderChanged(): void;
}) {
  const [menuShown, setMenuShown] = createSignal(false);
  const [recent, setRecent] = createSignal<RecentFolder[]>([]);
  const [currentPinned, setCurrentPinned] = createSignal(false);
  // A button's last direction, kept while another button is active, as Typora does.
  const [descending, setDescending] = createSignal<Record<string, boolean>>({});
  let menu!: HTMLUListElement;
  const mounted = () => props.folder !== null;

  const showMenu = () => {
    setRecent([]);
    setMenuShown(true);
    menu.focus();
    const content = document.getElementById("sidebar-content")?.clientHeight ?? 0;
    const item = menu.querySelector("a")?.clientHeight || 24;
    const limit = Math.max(0, Math.min(MAX_RECENT_FOLDERS, Math.floor((content - menu.clientHeight - 20) / item)));
    void props.backend
      .recentFolders()
      .then((dirs) => {
        setCurrentPinned(dirs.some((d) => d.path === props.folder && d.pinned));
        setRecent(dirs.filter((d) => d.path !== props.folder).slice(0, limit));
      })
      .catch(report);
  };
  /** The pin and remove buttons on a recent folder, which leave the menu open. */
  const folderButton = (run: () => Promise<unknown>) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button === 0) void run().catch(report);
  };
  const pinFolder = (dir: string, pinned: boolean) =>
    folderButton(() => props.backend.pinRecentFolder(dir, pinned).then(showMenu));
  const removeFolder = (dir: string) =>
    folderButton(async () => {
      await props.backend.removeRecentFolder(dir);
      setRecent((r) => r.filter((d) => d.path !== dir));
    });
  const hideMenu = () => setMenuShown(false);
  /** Menu items act on a left mousedown, as in Typora. */
  const act = (run: () => Promise<unknown>) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    // The item taking focus would end a rename the action starts, so the menu closes here.
    e.preventDefault();
    hideMenu();
    void run().catch(report);
  };
  const newFile = () => createLibraryFile(props.backend, props.onOpenFile);
  const switchFolder = async (dir?: string) => {
    if (await props.backend.switchLibraryFolder(dir)) props.onFolderChanged();
  };

  const tree = () => ui.fileTree;
  const sort = () => (tree() ? ui.librarySort.treeSort : ui.librarySort.listSort);
  const grouped = () => !(tree() ? ui.librarySort.treeNoGroup : ui.librarySort.listNoGroup);
  const update = (patch: Partial<typeof ui.librarySort>) =>
    void props.backend
      .updateSettings(patch)
      .then((s) => setUi("librarySort", librarySortOf(s)))
      .catch(report);
  const isDescending = (b: (typeof SORT_BUTTONS)[number]) => sort() === b.desc || (sort() !== b.asc && !!descending()[b.id]);
  const sortBy = (b: (typeof SORT_BUTTONS)[number]) => {
    const active = sort() === b.asc || sort() === b.desc;
    const next = active ? (sort() === b.asc ? b.desc : b.asc) : isDescending(b) ? b.desc : b.asc;
    setDescending({ ...descending(), [b.id]: next === b.desc });
    update(tree() ? { treeSort: next } : { listSort: next });
  };

  return (
    <div class="sidebar-footer no-selection" id="ty-sidebar-footer" classList={{ "show-sidebar-footer-context": menuShown() }}>
      <div style={{ display: "flex", background: "inherit" }}>
        <div
          class="sidebar-footer-item footer-item-right footer-btn file-action-item not-empty-menu-group"
          classList={{ show: mounted() }}
          id="sidebar-new-file-btn"
          ty-hint="New File"
          aria-label="New File"
          onClick={() => void newFile().catch(report)}
        >
          <span class="ty-icon ty-add">
            <AddIcon />
          </span>
        </div>
        <div class="sidebar-footer-main-item" id="sidebar-menu-btn">
          <span
            class="sidebar-footer-item"
            onMouseDown={(e) => {
              e.preventDefault();
              if (menuShown()) hideMenu();
              else showMenu();
            }}
          >
            <span class="sidebar-footer-main-item-label" id="sidebar-footer-main-item-label">
              {props.folder ? basename(props.folder) : "Open Folder..."}
            </span>
            <span class="footer-btn">
              <span class="ty-icon ty-dots-v" aria-hidden="true">
                <DotsIcon />
              </span>
            </span>
          </span>
          <ul
            ref={menu}
            id="sidebar-files-menu"
            class="dropdown-menu"
            role="menu"
            tabindex="-1"
            onBlur={() => setTimeout(hideMenu, 10)}
          >
            <Show when={mounted()}>
              <li role="presentation" class="menuitem-group-label file-action-item not-empty-menu-group show">
                <span>Action</span>
                <span
                  class="ty-icon ty-delete-button"
                  ty-hint="Close Sidebar Menu"
                  id="close-sidebar-menu-btn"
                  onMouseDown={hideMenu}
                >
                  <CloseIcon />
                </span>
              </li>
              <MenuItem id="new-file-from-sidebar-menu" label="New File" onMouseDown={act(newFile)} />
              <MenuItem id="search-from-sidebar-menu" label="Search" onMouseDown={act(async () => showFileSearch())} />
              <MenuItem
                id="reveal-folder-from-sidebar-menu"
                label="Reveal in Finder"
                onMouseDown={act(() => props.backend.revealLibrary())}
              />
              <MenuItem id="open-folder-from-sidebar-menu" label="Open Folder..." onMouseDown={act(() => switchFolder())} />
              <MenuItem
                id="refresh-from-sidebar-menu"
                label="Refresh Folder"
                onMouseDown={act(async () => setUi("libraryVersion", (v) => v + 1))}
              />
              <li role="presentation" class="menuitem-group-label file-action-item file-sort-item not-empty-menu-group show">
                <span>Sort</span>{" "}
                <span class="sort-button-area" onMouseDown={(e) => e.preventDefault()}>
                  <span>
                    <span
                      id="ty-group-by-folder-btn"
                      class="ty-icon ty-side-sort-btn"
                      classList={{ active: grouped() }}
                      ty-hint="Group By Folder"
                      aria-label="Group By Folder"
                      onMouseDown={() => update(tree() ? { treeNoGroup: grouped() } : { listNoGroup: grouped() })}
                    >
                      <GroupIcon />
                    </span>
                  </span>{" "}
                  {/* Spaced like Typora's markup, whose line breaks between buttons show as spaces. */}
                  <span>
                    <For each={SORT_BUTTONS}>
                      {(b, i) => {
                        const hint = () => `${b.hint} (${isDescending(b) ? "Descending" : "Ascending"})`;
                        return (
                          <>
                            {i() > 0 && " "}
                            <span
                              id={b.id}
                              class="ty-icon ty-side-sort-btn ty-side-sort-btn2"
                              classList={{ active: sort() === b.asc || sort() === b.desc }}
                              ty-hint={hint()}
                              aria-label={hint()}
                              onMouseDown={() => sortBy(b)}
                            >
                              <b.icon descending={isDescending(b)} />
                            </span>
                          </>
                        );
                      }}
                    </For>
                  </span>
                </span>
                <div class="clearfix" />
              </li>
            </Show>
            <Show when={props.folder !== null || recent().length > 0}>
              <li role="presentation" class="menuitem-group-label file-action-item folder-menu-group show">
                <span>Recent Locations</span>
              </li>
              <For each={recent()}>
                {(dir) => (
                  <FolderItem
                    dir={dir.path}
                    pinned={dir.pinned}
                    title={props.title}
                    onMouseDown={act(() => switchFolder(dir.path))}
                    onPin={pinFolder(dir.path, !dir.pinned)}
                    onRemove={removeFolder(dir.path)}
                  />
                )}
              </For>
              <Show when={props.folder}>
                {(dir) => (
                  <FolderItem
                    dir={dir()}
                    pinned={currentPinned()}
                    title={props.title}
                    selected
                    onMouseDown={hideMenu}
                    onPin={pinFolder(dir(), !currentPinned())}
                    onRemove={removeFolder(dir())}
                  />
                )}
              </Show>
            </Show>
            <Show when={!mounted()}>
              <li
                role="presentation"
                class="menuitem-group-label file-action-item empty-menu-group show"
                id="folder-menu-item-after"
              >
                <span>Location</span>
              </li>
              <MenuItem id="open-folder-from-sidebar-menu" label="Open Folder..." onMouseDown={act(() => switchFolder())} />
            </Show>
          </ul>
        </div>
        <div
          class="sidebar-footer-item footer-item-right footer-btn file-action-item not-empty-menu-group"
          classList={{ show: mounted() }}
          id="switch-file-list-btn"
          ty-hint="Switch File List/Tree View"
          aria-label="Switch File List/Tree View"
          onClick={() => setUi("fileTree", !ui.fileTree)}
        >
          <span class="switch-file-list-btn-to-list">
            <span class="ty-icon ty-three-cells">
              <CellsIcon />
            </span>
          </span>
          <span class="switch-file-list-btn-to-tree">
            <span class="ty-icon ty-file-tree">
              <TreeIcon />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function MenuItem(props: { id: string; label: string; onMouseDown(e: MouseEvent): void }) {
  return (
    <li role="presentation" class="file-action-item show">
      <a role="menuitem" tabindex="-1" id={props.id} onMouseDown={(e) => props.onMouseDown(e)}>
        {props.label}
      </a>
    </li>
  );
}

function FolderItem(props: {
  dir: string;
  pinned: boolean;
  selected?: boolean;
  title(path: string): string;
  onMouseDown(e: MouseEvent): void;
  onPin(e: MouseEvent): void;
  onRemove(e: MouseEvent): void;
}) {
  return (
    <li
      role="presentation"
      class="folder-menu-item file-action-item folder-menu-groupm show"
      classList={{ "selected-folder-menu-item": !!props.selected }}
      data-path={props.dir}
      data-pinned={String(props.pinned)}
      ty-hint={props.title(props.dir)}
    >
      <a role="menuitem" tabindex="-1" onMouseDown={(e) => props.onMouseDown(e)}>
        <i class="fa fa-folder-o">
          <FolderOutlineIcon />
        </i>
        <span style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis" }}>{basename(props.dir)}</span>
        <i
          class="fa fa-thumb-tack sidebar-folder-right-icon sidebar-folder-pin"
          ty-hint={props.pinned ? "Unpin" : "Pin"}
          onMouseDown={(e) => props.onPin(e)}
        >
          <PinIcon />
        </i>
        <i
          class="fa fa-trash-o sidebar-folder-right-icon sidebar-folder-remove"
          ty-hint="Remove from List"
          onMouseDown={(e) => props.onRemove(e)}
        >
          <TrashIcon />
        </i>
      </a>
    </li>
  );
}

function PinIcon() {
  return (
    <Svg width={12} height={12}>
      <path d="M4 1.2h4M4.8 1.2v3.6L3 7h6L7.2 4.8V1.2M6 7v4.2" {...stroke} />
    </Svg>
  );
}

function TrashIcon() {
  return (
    <Svg width={12} height={12}>
      <path d="M1.6 2.8h8.8M4.4 2.8V1.4h3.2v1.4M2.8 2.8l.6 8h5.2l.6-8M5 4.8v4M7 4.8v4" {...stroke} />
    </Svg>
  );
}

function OutlineEntry(props: { node: OutlineNode; onClick(pos: number): void }) {
  const active = () => props.node.index === ui.activeHeading;
  /** The filter's match in the heading: null when it is filtered out, [] when no filter. */
  const hit = () => {
    const pattern = outlineFilterPattern();
    if (!pattern) return [];
    const m = pattern.exec(props.node.item.text);
    return m ? [m.index, m.index + m[0].length] : null;
  };
  const label = () => {
    const text = props.node.item.text || " ";
    const h = hit();
    if (!h?.length || h[0] === h[1]) return text;
    return [text.slice(0, h[0]), <span class="ty-outline-hit">{text.slice(h[0], h[1])}</span>, text.slice(h[1])];
  };
  return (
    <li
      class={`outline-item-wrapper outline-h${props.node.item.level}`}
      classList={{ "outline-item-single": !props.node.children.length }}
    >
      <div
        class="outline-item"
        classList={{ "outline-item-active": active(), "ty-outline-miss": hit() === null }}
        onClick={() => props.onClick(props.node.item.pos)}
      >
        <span class="outline-expander" />
        <span class="outline-label" classList={{ "outline-active": active() }}>
          {label()}
        </span>
      </div>
      <ul class="outline-children">
        <For each={props.node.children}>{(child) => <OutlineEntry node={child} onClick={props.onClick} />}</For>
      </ul>
    </li>
  );
}

/** The box a file's name is typed into: Enter or leaving it renames, Esc cancels. The
 * name without its extension starts selected, as in Finder. */
function RenameInput(props: { name: string; class?: string; onDone(name: string | null): void }) {
  let input!: HTMLInputElement;
  let done = false;
  const finish = (name: string | null) => {
    if (done) return;
    done = true;
    props.onDone(name === props.name ? null : name);
  };
  const focus = () => {
    if (done || !input.isConnected || document.activeElement === input) return;
    // In the tree, Typora fits the box to the room left in the sidebar.
    const div = input.parentElement;
    const room = document.getElementById("sidebar-content")?.clientWidth;
    if (div?.classList.contains("file-tree-rename-div") && room)
      input.style.width = `${Math.max(140, Math.min(200, room - 48 - div.offsetLeft))}px`;
    input.focus();
    const dot = props.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : props.name.length);
  };
  // Again a frame later: a list that is still being redrawn may not show it yet.
  onMount(() => {
    focus();
    requestAnimationFrame(focus);
  });
  return (
    <input
      ref={input}
      class={props.class}
      type="text"
      value={props.name}
      spellcheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(input.value);
        else if (e.key === "Escape") finish(null);
      }}
      // Checked a moment later: WebKit blurs a box while taking it out of the page with
      // its list, which is no reason to rename.
      onBlur={() => setTimeout(() => input.isConnected && document.activeElement !== input && finish(input.value))}
    />
  );
}

function ListItem(props: {
  file: LibraryDoc;
  title(path: string): string;
  onOpenFile(path: string): void;
  onRename(path: string, name: string | null): void;
}) {
  const [name, ext] = splitName(props.file.name);
  const renaming = () => ui.renaming === props.file.path;
  return (
    <div
      class="file-list-item file-library-node file-library-file-node"
      classList={{ active: props.file.path === ui.path }}
      data-path={props.file.path}
      data-parent-path={props.file.folder}
      tabindex="-1"
      onClick={() => !renaming() && props.onOpenFile(props.file.path)}
    >
      <div class="file-list-item-parent-loc">{basename(props.file.folder)}</div>
      <div class="file-list-item-time">{naturalDate(new Date(props.file.modified))}</div>
      <Show
        when={renaming()}
        fallback={
          <div class="file-list-item-file-name" title={props.title(props.file.path)}>
            <span class="file-list-item-file-name-part">{name}</span>
            <span class="file-list-item-file-ext-part">{ext}</span>
          </div>
        }
      >
        <RenameInput
          class="file-list-item-file-name"
          name={props.file.name}
          onDone={(to) => props.onRename(props.file.path, to)}
        />
      </Show>
      <div class="file-list-item-summary">
        <For each={summaryLines(summaryOf(props.file.summary))}>
          {(line, i) => (
            <>
              <Show when={i() > 0}>
                <br />
              </Show>
              {line}
            </>
          )}
        </For>
      </div>
    </div>
  );
}

function TreeNode(props: {
  entry: LibraryEntry;
  root?: boolean;
  list(path: string): Promise<LibraryEntry[]>;
  title(path: string): string;
  onOpenFile(path: string): void;
  onRename(path: string, name: string | null): void;
}) {
  const e = props.entry;
  // Folders on the way to the open document, or to a file being renamed, start expanded, as in Typora.
  const [open, setOpen] = createSignal(
    !!props.root || !!ui.path?.startsWith(`${e.path}/`) || !!ui.renaming?.startsWith(`${e.path}/`),
  );
  const [children, setChildren] = createSignal<LibraryEntry[] | null>(null);
  createEffect(() => {
    if (e.isDirectory && open() && !children()) void props.list(e.path).then(setChildren);
  });
  const [name, ext] = splitName(e.name, e.isDirectory);
  const expandable = () => e.isDirectory && !props.root && e.hasChildren;
  const renaming = () => ui.renaming === e.path;
  const click = () => {
    if (renaming()) return;
    if (!e.isDirectory) props.onOpenFile(e.path);
    else if (expandable()) setOpen(!open());
  };
  return (
    <div
      class="file-library-node file-tree-node"
      classList={{
        "file-node-root": !!props.root,
        "file-node-expanded": expandable() && open(),
        "file-node-collapsed": expandable() && !open(),
        "file-library-file-node": !e.isDirectory,
        "file-node-on-edit": renaming(),
        active: e.path === ui.path,
      }}
      data-path={e.path}
      data-has-sub={String(expandable())}
      data-is-directory={String(e.isDirectory)}
      tabindex="-1"
    >
      <div class="file-node-background" />
      <div class="file-node-content" onClick={click}>
        <Show when={!props.root}>
          <span class="file-node-open-state">
            <CaretRight />
            <CaretDown />
          </span>
        </Show>
        <i class="file-node-icon">{e.isDirectory ? <FolderIcon /> : <FileIcon />}</i>
        <span class="file-node-title" title={props.title(e.path)}>
          <span class="file-node-title-name-part">{name}</span>
          <span class="file-node-title-ext-part">{ext}</span>
        </span>
        <Show when={renaming()}>
          <div class="file-tree-rename-div">
            <RenameInput name={e.name} onDone={(to) => props.onRename(e.path, to)} />
          </div>
        </Show>
      </div>
      <div class="file-node-children">
        <Show when={open()}>
          <For each={sortEntries(children() ?? [], ui.librarySort.treeSort, ui.librarySort.treeNoGroup)}>
            {(child) => (
              <TreeNode entry={child} list={props.list} title={props.title} onOpenFile={props.onOpenFile} onRename={props.onRename} />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

export function Spinner() {
  return (
    <div class="typora-search-spinner">
      <div class="rect1" />
      <div class="rect2" />
      <div class="rect3" />
      <div class="rect4" />
      <div class="rect5" />
    </div>
  );
}

// Icons drawn for Marpora, sized like the Font Awesome glyphs Typora uses at 14px.

function Svg(props: { width: number; height: number; class?: string; children: JSX.Element }) {
  return (
    <svg class={props.class} width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`}>
      {props.children}
    </svg>
  );
}

function FolderIcon() {
  return (
    <Svg width={13} height={11}>
      <path d="M1.2 0h3.6l1.4 1.6h5.6c.66 0 1.2.54 1.2 1.2V9.8c0 .66-.54 1.2-1.2 1.2H1.2C.54 11 0 10.46 0 9.8V1.2C0 .54.54 0 1.2 0z" />
    </Svg>
  );
}

function FileIcon() {
  return (
    <Svg width={12} height={14}>
      <path
        d="M1.5.5h6l3.5 3.5v8.5c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1v-11c0-.55.45-1 1-1zM7.5.5V4H11M3 7h6M3 9h6M3 11h6"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
      />
    </Svg>
  );
}

function CaretRight() {
  return (
    <Svg width={5} height={8} class="caret-right">
      <path d="M0 0l5 4-5 4z" />
    </Svg>
  );
}

function CaretDown() {
  return (
    <Svg width={8} height={5} class="caret-down">
      <path d="M0 0h8L4 5z" />
    </Svg>
  );
}

const stroke = { fill: "none", stroke: "currentColor", "stroke-width": "1.2" };

function ListIcon() {
  return (
    <Svg width={14} height={12}>
      <path d="M4 1.5h10M4 6h10M4 10.5h10" {...stroke} />
      <path d="M0 1.5h1.6M0 6h1.6M0 10.5h1.6" {...stroke} stroke-width="1.6" />
    </Svg>
  );
}

function CellsIcon() {
  return (
    <Svg width={14} height={12}>
      <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1" {...stroke} />
      <path d="M0.6 4.2h12.8M0.6 7.8h12.8" {...stroke} />
    </Svg>
  );
}

function TreeIcon() {
  return (
    <Svg width={14} height={12}>
      <path d="M1.5 0v10.5h4M1.5 4.5h4" {...stroke} />
      <rect x="6.6" y="2.6" width="6.8" height="3.8" rx="0.8" {...stroke} />
      <rect x="6.6" y="8.1" width="6.8" height="3.3" rx="0.8" {...stroke} />
    </Svg>
  );
}

function AddIcon() {
  return (
    <Svg width={12} height={12}>
      <path d="M6 0.5v11M0.5 6h11" {...stroke} />
    </Svg>
  );
}

function DotsIcon() {
  return (
    <Svg width={4} height={12}>
      <circle cx="2" cy="2" r="1.4" />
      <circle cx="2" cy="6" r="1.4" />
      <circle cx="2" cy="10" r="1.4" />
    </Svg>
  );
}

function CloseIcon() {
  return (
    <Svg width={13} height={13}>
      <circle cx="6.5" cy="6.5" r="5.9" {...stroke} />
      <path d="M4.3 4.3l4.4 4.4M8.7 4.3l-4.4 4.4" {...stroke} />
    </Svg>
  );
}

function FolderOutlineIcon() {
  return (
    <Svg width={13} height={11}>
      <path d="M1.2.6h3.4l1.4 1.6h5.8c.4 0 .6.3.6.6v6.9c0 .4-.3.7-.6.7H1.2c-.3 0-.6-.3-.6-.7V1.2c0-.3.3-.6.6-.6z" {...stroke} />
    </Svg>
  );
}

function GroupIcon() {
  return (
    <Svg width={14} height={14}>
      <path d="M2.6 4.6h8.8l.6 8.2H2zM4.6 4.6V3.4a2.4 2.4 0 0 1 4.8 0v1.2" {...stroke} />
    </Svg>
  );
}

/** The arrow of a sort button, up for ascending. */
function SortArrow(props: { descending: boolean }) {
  return (
    <path d={props.descending ? "M2.5 1.5v11M0.3 10.2l2.2 2.3 2.2-2.3" : "M2.5 12.5v-11M0.3 3.8l2.2-2.3 2.2 2.3"} {...stroke} />
  );
}

function NaturalSortIcon(props: { descending: boolean }) {
  return (
    <Svg width={16} height={14}>
      <SortArrow descending={props.descending} />
      <circle cx="11" cy="5" r="3.6" {...stroke} />
      <circle cx="11" cy="5" r="1.3" />
    </Svg>
  );
}

function NameSortIcon(props: { descending: boolean }) {
  return (
    <Svg width={16} height={14}>
      <SortArrow descending={props.descending} />
      <path d="M6.6 12.5 10.3 1.5h.4l3.7 11M8 8.6h5" {...stroke} stroke-width="1.4" />
    </Svg>
  );
}

function DateSortIcon(props: { descending: boolean }) {
  return (
    <Svg width={16} height={14}>
      <SortArrow descending={props.descending} />
      <circle cx="11" cy="7.5" r="4.4" {...stroke} />
      <path d="M11 5v2.8h2" {...stroke} />
    </Svg>
  );
}

function CreatedSortIcon(props: { descending: boolean }) {
  return (
    <Svg width={16} height={14}>
      <SortArrow descending={props.descending} />
      <path d="M6.6 1.6h4.6l3.2 3.2v7.6H6.6zM11 1.6v3.4h3.4" {...stroke} />
    </Svg>
  );
}
