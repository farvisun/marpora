// The sidebar with Typora's macOS markup: one tab title at a time (Outline, Articles or
// Files) with a button to switch, the outline as nested lists, and the document's
// folder as an article list (the default) or a file tree. Themes style these ids and
// classes, so they follow Typora's.

import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import type { Backend, LibraryDoc, LibraryEntry, LibraryInfo } from "../ipc";
import {
  abbreviate,
  basename,
  groupByFolder,
  naturalCompare,
  naturalDate,
  splitName,
  summaryLines,
  summaryOf,
} from "./library";
import { type OutlineItem, saveSidebar, setUi, ui } from "./store";

export interface SidebarProps {
  backend: Backend;
  onOutlineClick(pos: number): void;
  onOpenFile(path: string): void;
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
  // A different folder lists again.
  createEffect(on(folder, () => setList({ state: "", files: [] }), { defer: true }));

  const groups = () => groupByFolder(list().files);
  const showFolderNames = () => list().files.some((f) => f.folder !== folder());
  const listChildren = (path: string) =>
    props.backend.listFolder(path).then((entries) => {
      const sorted = (dir: boolean) =>
        entries.filter((e) => e.isDirectory === dir).sort((a, b) => naturalCompare(a.name, b.name));
      return [...sorted(true), ...sorted(false)];
    });

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
          <div class="sidebar-tab-btn" />
        </div>
      </div>
      <div class="sidebar-content" id="sidebar-content">
        <div id="outline-content" class="outline-content sidebar-content-content" data-after-content="Outline is Empty.">
          <For each={outlineTree(ui.outline)}>
            {(node) => <OutlineEntry node={node} onClick={props.onOutlineClick} />}
          </For>
        </div>
        <div id="file-library" class="sidebar-content-content">
          <div
            id="file-library-tree"
            class="no-selection"
            data-after-content="No Folder is Opened."
            data-state={ui.fileTree && filesShown() && info() === null ? "rendering" : "complete"}
            tabindex="0"
          >
            <Show when={ui.fileTree && filesShown() && folder()}>
              {(dir) => (
                <TreeNode
                  entry={{ name: basename(dir()), path: dir(), isDirectory: true, hasChildren: true, modified: 0, created: 0 }}
                  root
                  list={listChildren}
                  title={shortPath}
                  onOpenFile={props.onOpenFile}
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
                    {(file) => <ListItem file={file} title={shortPath} onOpenFile={props.onOpenFile} />}
                  </For>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OutlineEntry(props: { node: OutlineNode; onClick(pos: number): void }) {
  const active = () => props.node.index === ui.activeHeading;
  return (
    <li
      class={`outline-item-wrapper outline-h${props.node.item.level}`}
      classList={{ "outline-item-single": !props.node.children.length }}
    >
      <div class="outline-item" classList={{ "outline-item-active": active() }} onClick={() => props.onClick(props.node.item.pos)}>
        <span class="outline-expander" />
        <span class="outline-label" classList={{ "outline-active": active() }}>
          {props.node.item.text || " "}
        </span>
      </div>
      <ul class="outline-children">
        <For each={props.node.children}>{(child) => <OutlineEntry node={child} onClick={props.onClick} />}</For>
      </ul>
    </li>
  );
}

function ListItem(props: { file: LibraryDoc; title(path: string): string; onOpenFile(path: string): void }) {
  const [name, ext] = splitName(props.file.name);
  return (
    <div
      class="file-list-item file-library-node file-library-file-node"
      classList={{ active: props.file.path === ui.path }}
      data-path={props.file.path}
      data-parent-path={props.file.folder}
      tabindex="-1"
      onClick={() => props.onOpenFile(props.file.path)}
    >
      <div class="file-list-item-parent-loc">{basename(props.file.folder)}</div>
      <div class="file-list-item-time">{naturalDate(new Date(props.file.modified))}</div>
      <div class="file-list-item-file-name" title={props.title(props.file.path)}>
        <span class="file-list-item-file-name-part">{name}</span>
        <span class="file-list-item-file-ext-part">{ext}</span>
      </div>
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
}) {
  const e = props.entry;
  // Folders on the way to the open document start expanded, as in Typora.
  const [open, setOpen] = createSignal(!!props.root || !!ui.path?.startsWith(`${e.path}/`));
  const [children, setChildren] = createSignal<LibraryEntry[] | null>(null);
  createEffect(() => {
    if (e.isDirectory && open() && !children()) void props.list(e.path).then(setChildren);
  });
  const [name, ext] = splitName(e.name, e.isDirectory);
  const expandable = () => e.isDirectory && !props.root && e.hasChildren;
  const click = () => {
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
      </div>
      <div class="file-node-children">
        <Show when={open()}>
          <For each={children()}>
            {(child) => <TreeNode entry={child} list={props.list} title={props.title} onOpenFile={props.onOpenFile} />}
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
