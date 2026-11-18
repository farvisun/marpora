// Text direction of blocks, for the view only: nothing here reaches the file.
//
// A text block is right-to-left when its first letter is from a right-to-left script
// (Persian, Arabic, Hebrew, ...) or when most of its letters are. An empty block follows
// the block before it, so a new line after Persian text stays on the right. Containers
// (list items, lists, quotes, footnotes) take the direction of their first text block, so
// bullets and quote bars sit on the side the text starts; a table takes its header row's.
//
// The user can set a text block's direction by hand. Those choices follow the block
// through edits and are remembered by the hash of the block's text (`remembered`), which
// the window keeps in localStorage per file, so they come back when the file opens again.

import type { Node as PMNode } from "prosemirror-model";
import { type Command, type EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { type Build, buildAll, changedRanges, rebuild } from "./blockwise";

/** sync.ts's `remoteMeta`, here so this module does not load the parser. */
const remoteMeta = "marpora-remote";

export type Dir = "ltr" | "rtl";

const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;
const LETTER = /\p{L}/gu;

/** The direction of `text`: right-to-left when its first letter is, or most of its letters
 * are; null when it has no letters. */
export function detectDir(text: string): Dir | null {
  let first: boolean | null = null;
  let rtl = 0;
  let ltr = 0;
  for (const [ch] of text.matchAll(LETTER)) {
    const r = RTL_LETTER.test(ch);
    first ??= r;
    if (r) rtl++;
    else ltr++;
  }
  if (first === null) return null;
  return first || rtl > ltr ? "rtl" : "ltr";
}

/** A short hash of a block's text (FNV-1a and the length), to remember its direction by. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + text.length.toString(36);
}

/** The key a text block's direction is remembered by; null for empty blocks. */
function keyOf(node: PMNode): string | null {
  const text = node.textContent.trim();
  return text ? textHash(text) : null;
}

/** Text blocks that get a direction (code, math and raw blocks stay left-to-right). */
const TEXT = new Set(["paragraph", "heading", "table_header", "table_cell"]);
/** Containers that take the direction of their first text block. */
const CONTAINERS = new Set(["list_item", "bullet_list", "ordered_list", "blockquote", "footnote_def"]);
/** Table parts walked through without a direction of their own. */
const TABLE_PARTS = new Set(["table", "table_head", "table_body", "table_row"]);

interface DirState {
  /** The `dir` attributes shown; each spec's `shown` holds its direction. */
  decos: DecorationSet;
  /** Text blocks set by hand, as node decorations whose spec's `dir` holds the direction. */
  overrides: DecorationSet;
  /** Directions set by hand, by text hash: from storage and from this session. */
  remembered: Map<string, Dir>;
}

type Meta = { set: Dir | null; ranges: [number, number][] } | { load: Record<string, Dir> };

export const directionKey = new PluginKey<DirState>("marpora-direction");

const isOverride = (spec: { dir?: Dir }) => spec.dir !== undefined;

/** The override decorations that start at `pos`. */
function overridesAt(overrides: DecorationSet, pos: number, node: PMNode): Decoration[] {
  return overrides.find(pos, pos + node.nodeSize, isOverride).filter((d) => d.from === pos);
}

function overrideAt(overrides: DecorationSet, pos: number, node: PMNode): Dir | null {
  return (overridesAt(overrides, pos, node)[0]?.spec.dir as Dir | undefined) ?? null;
}

/** The decorations of the top-level blocks between `from` and `to`. */
function builder(overrides: DecorationSet): Build {
  return (doc, from, to) => {
    const decos: Decoration[] = [];

    /** Decorate `node` at `pos`, after a block shown `before`; returns its direction. */
    const visit = (node: PMNode, pos: number, before: Dir | null): Dir | null => {
      const name = node.type.name;
      let dir: Dir | null = null;
      if (TEXT.has(name)) {
        dir = overrideAt(overrides, pos, node) ?? detectDir(node.textContent) ?? (node.content.size === 0 ? before : null);
      } else if (CONTAINERS.has(name) || TABLE_PARTS.has(name)) {
        let prev = before;
        let first: Dir | null = null;
        let offset = pos + 1;
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          const d = visit(child, offset, prev);
          offset += child.nodeSize;
          if (d) prev = d;
          if (i === 0) first = d;
        }
        if (name === "table") dir = detectDir(node.firstChild?.textContent ?? "");
        else if (TABLE_PARTS.has(name)) return null;
        else dir = first;
      } else {
        return null;
      }
      if (dir) decos.push(Decoration.node(pos, pos + node.nodeSize, { dir }, { shown: dir }));
      return dir;
    };

    // The direction of the blocks before `from`, for an empty first block to follow.
    let before: Dir | null = null;
    const index = doc.resolve(Math.min(from, doc.content.size)).index(0);
    let pos = 0;
    const starts: number[] = [];
    for (let i = 0; i < index; i++) {
      starts.push(pos);
      pos += doc.child(i).nodeSize;
    }
    for (let i = index - 1; i >= 0 && before === null; i--) {
      const node = doc.child(i);
      if (!TEXT.has(node.type.name) && !CONTAINERS.has(node.type.name)) break;
      before = visit(node, starts[i], null);
    }
    decos.length = 0;

    doc.nodesBetween(from, to, (node, at) => {
      if (at < from) return true;
      const d = visit(node, at, before);
      // A block without a direction (code, a rule) ends what an empty block follows.
      before = d;
      return false;
    });
    return decos;
  };
}

/** The text blocks in `ranges` of `doc`, with their positions. */
function textBlocks(doc: PMNode, ranges: [number, number][]): [number, PMNode][] {
  const out: [number, PMNode][] = [];
  const seen = new Set<number>();
  for (const [from, to] of ranges) {
    doc.nodesBetween(Math.max(0, from), Math.min(to, doc.content.size), (node, pos) => {
      if (TEXT.has(node.type.name)) {
        if (!seen.has(pos)) out.push([pos, node]);
        seen.add(pos);
        return false;
      }
      return !node.isTextblock;
    });
  }
  return out;
}

/** `ranges` widened to the end of the top-level block after each, which may follow them. */
function withNext(doc: PMNode, ranges: [number, number][]): [number, number][] {
  return ranges.map(([from, to]) => {
    const end = Math.min(Math.max(to, 0), doc.content.size);
    const index = doc.resolve(end).index(0);
    let after = 0;
    for (let i = 0; i <= index + 1 && i < doc.childCount; i++) after += doc.child(i).nodeSize;
    return [from, Math.max(end, after)];
  });
}

/** The overrides of the text blocks in `ranges`, fitted to their blocks again after
 * edits (a split block leaves its override on the first part), and with `reattach`,
 * taken from `remembered` where a block has none. */
function syncOverrides(
  doc: PMNode,
  overrides: DecorationSet,
  remembered: Map<string, Dir>,
  ranges: [number, number][],
  reattach: boolean,
) {
  const add: Decoration[] = [];
  const remove: Decoration[] = [];
  for (const [pos, node] of textBlocks(doc, ranges)) {
    const here = overridesAt(overrides, pos, node);
    if (here.length === 1 && here[0].to === pos + node.nodeSize) continue;
    const key = reattach && !here.length ? keyOf(node) : null;
    const dir = (here[0]?.spec.dir as Dir | undefined) ?? (key ? remembered.get(key) : undefined);
    remove.push(...here);
    if (dir) add.push(Decoration.node(pos, pos + node.nodeSize, {}, { dir }));
  }
  if (remove.length) overrides = overrides.remove(remove);
  return add.length ? overrides.add(doc, add) : overrides;
}

/** Remember the overrides of `doc` by their blocks' text as it is now. */
function rememberAll(doc: PMNode, overrides: DecorationSet, remembered: Map<string, Dir>) {
  for (const d of overrides.find()) {
    const node = doc.nodeAt(d.from);
    const key = node?.isTextblock ? keyOf(node) : null;
    if (key) remembered.set(key, d.spec.dir as Dir);
  }
}

function apply(tr: Transaction, value: DirState): DirState {
  const meta = tr.getMeta(directionKey) as Meta | undefined;
  if (!tr.docChanged && !meta) return value;
  const { doc } = tr;
  const remembered = value.remembered;
  // Blocks replaced from outside (the file changed on disk, source mode, agents) get
  // their overrides back by their text, so note the text they have before.
  const remote = tr.docChanged && !!tr.getMeta(remoteMeta);
  if (remote) rememberAll(tr.before, value.overrides, remembered);
  let overrides = tr.docChanged ? value.overrides.map(tr.mapping, doc) : value.overrides;
  let ranges: [number, number][] = tr.docChanged ? changedRanges(tr) : [];

  if (meta && "load" in meta) {
    for (const [hash, dir] of Object.entries(meta.load)) remembered.set(hash, dir);
    overrides = syncOverrides(doc, overrides, remembered, [[0, doc.content.size]], true);
    return { decos: buildAll(doc, builder(overrides)), overrides, remembered };
  }
  if (meta) {
    for (const [pos, node] of textBlocks(doc, meta.ranges)) {
      overrides = overrides.remove(overridesAt(overrides, pos, node));
      const key = keyOf(node);
      if (meta.set) {
        overrides = overrides.add(doc, [Decoration.node(pos, pos + node.nodeSize, {}, { dir: meta.set })]);
        if (key) remembered.set(key, meta.set);
      } else if (key) {
        remembered.delete(key);
      }
    }
    ranges = ranges.concat(meta.ranges);
  }
  overrides = syncOverrides(doc, overrides, remembered, ranges, remote);
  const decos = rebuild(value.decos, tr, withNext(doc, ranges), builder(overrides));
  return { decos, overrides, remembered };
}

export const directionPlugin = new Plugin<DirState>({
  key: directionKey,
  state: {
    init: (_, state) => {
      const overrides = DecorationSet.empty;
      return { decos: buildAll(state.doc, builder(overrides)), overrides, remembered: new Map() };
    },
    apply,
  },
  props: {
    decorations: (state) => directionKey.getState(state)?.decos,
  },
});

/** Remembered directions (from storage) to apply to the document's blocks. */
export function loadDirections(view: EditorView, saved: Record<string, Dir>) {
  view.dispatch(view.state.tr.setMeta(directionKey, { load: saved } satisfies Meta).setMeta("addToHistory", false));
}

/** The directions set by hand on the document's blocks, by text hash, to store. */
export function savedDirections(state: EditorState): Record<string, Dir> {
  const out: Record<string, Dir> = {};
  for (const d of directionKey.getState(state)?.overrides.find() ?? []) {
    const node = state.doc.nodeAt(d.from);
    const key = node?.isTextblock ? keyOf(node) : null;
    if (key) out[key] = d.spec.dir as Dir;
  }
  return out;
}

/** The direction shown for the text block holding `pos`, and whether it was set by hand. */
export function directionAt(state: EditorState, pos = state.selection.from): { dir: Dir | null; manual: boolean } {
  const value = directionKey.getState(state);
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (!TEXT.has(node.type.name)) continue;
    const start = $pos.before(d);
    const end = start + node.nodeSize;
    const manual = value ? overrideAt(value.overrides, start, node) : null;
    const shown = value?.decos.find(start, end, (spec) => spec.shown !== undefined).find((x) => x.from === start && x.to === end);
    return { dir: manual ?? (shown?.spec.shown as Dir | undefined) ?? null, manual: manual !== null };
  }
  return { dir: null, manual: false };
}

/** Set (or with null, clear) the direction of the text blocks in the selection. */
export function setDirection(dir: Dir | null): Command {
  return (state, dispatch) => {
    const ranges = state.selection.ranges.map((r): [number, number] => [r.$from.pos, r.$to.pos]);
    if (!textBlocks(state.doc, ranges).length) return false;
    dispatch?.(state.tr.setMeta(directionKey, { set: dir, ranges } satisfies Meta).setMeta("addToHistory", false));
    return true;
  };
}

/** Flip the direction of the text blocks in the selection, from the one at the cursor. */
export const toggleDirection: Command = (state, dispatch, view) =>
  setDirection(directionAt(state).dir === "rtl" ? "ltr" : "rtl")(state, dispatch, view);

const STORE = "marpora.dir:";

/** The directions set by hand in the file at `path`, as stored. */
export function storedDirections(path: string | null): Record<string, Dir> {
  if (!path) return {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORE + path) ?? "{}");
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter(([, d]) => d === "ltr" || d === "rtl")) as Record<string, Dir>;
  } catch {
    return {};
  }
}

/** Store the directions set by hand in `state` for the file at `path`. */
export function storeDirections(path: string | null, state: EditorState) {
  if (!path) return;
  const saved = savedDirections(state);
  try {
    if (Object.keys(saved).length) localStorage.setItem(STORE + path, JSON.stringify(saved));
    else localStorage.removeItem(STORE + path);
  } catch {
    // Storage full or off: the choices last for this session.
  }
}

/** Store the directions set by hand in the file at `path()` shortly after they change. */
export function directionStore(path: () => string | null): Plugin {
  return new Plugin({
    view: () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        update(view, prev) {
          if (directionKey.getState(view.state)?.overrides === directionKey.getState(prev)?.overrides) return;
          clearTimeout(timer);
          timer = setTimeout(() => storeDirections(path(), view.state), 500);
        },
        destroy: () => clearTimeout(timer),
      };
    },
  });
}
