// Keeps the Rust document in step with the editor at the granularity of top-level blocks.
//
// ProseMirror shares unchanged child nodes between document versions, so comparing the
// last synced doc with the current one by identity finds the changed block range cheaply.
// Only those blocks are serialized and sent; the core keeps every other byte as it was.

import { Fragment, Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Backend, Patch, RemotePatch } from "../ipc";
import { parseMarkdown, serializeBlocks } from "../md";
import { schema } from "./schema";

/** Transactions carrying this meta came from the core and must not be sent back. */
export const remoteMeta = "marpora-remote";

export interface BlockRange {
  start: number;
  delete: number;
  insert: PMNode[];
}

/** The smallest range of top-level blocks that turns `a` into `b`. */
export function diffBlocks(a: PMNode, b: PMNode): BlockRange | null {
  const ac = a.childCount;
  const bc = b.childCount;
  let prefix = 0;
  while (prefix < ac && prefix < bc && a.child(prefix) === b.child(prefix)) prefix++;
  if (prefix === ac && prefix === bc) return null;
  let suffix = 0;
  const max = Math.min(ac, bc) - prefix;
  while (suffix < max && a.child(ac - 1 - suffix) === b.child(bc - 1 - suffix)) suffix++;
  const insert: PMNode[] = [];
  for (let i = prefix; i < bc - suffix; i++) insert.push(b.child(i));
  return { start: prefix, delete: ac - prefix - suffix, insert };
}

function blockPos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function replaceBlocks(doc: PMNode, r: BlockRange): PMNode {
  const children: PMNode[] = [];
  doc.forEach((n) => children.push(n));
  children.splice(r.start, r.delete, ...r.insert);
  return doc.copy(Fragment.from(children));
}

export class DocSync {
  private synced: PMNode;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private view: EditorView | null = null;

  constructor(
    private backend: Backend,
    readonly docId: number,
    doc: PMNode,
    private version: number,
    /** Delay before sending, so fast typing produces one patch per burst. */
    private delay = 40,
  ) {
    this.synced = doc;
  }

  plugin(): Plugin {
    return new Plugin({
      key: new PluginKey("marpora-sync"),
      view: (view) => {
        this.view = view;
        return {
          update: (v, prev) => {
            if (v.state.doc !== prev.doc) this.schedule();
          },
          destroy: () => {
            this.view = null;
          },
        };
      },
    });
  }

  get currentVersion() {
    return this.version;
  }

  /** Send any pending edit now (before saving, closing, or running a command). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.inflight) await this.inflight;
    const view = this.view;
    if (!view) return;
    const doc = view.state.doc;
    const range = diffBlocks(this.synced, doc);
    if (!range) return;
    const patch: Patch = {
      baseVersion: this.version,
      start: range.start,
      delete: range.delete,
      insert: serializeBlocks(range.insert),
    };
    this.inflight = this.backend.applyPatch(this.docId, patch).then(async (res) => {
      if (res.ok) {
        this.version = res.version;
        this.synced = doc;
      } else {
        await this.resync();
      }
    });
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
    // Edits made while the patch was in flight.
    if (this.view && this.view.state.doc !== this.synced) this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  /**
   * Apply an edit made outside the editor. Unsent local edits survive when they touch
   * other blocks; on overlap the core's version wins.
   */
  async applyRemote(patch: RemotePatch): Promise<void> {
    const view = this.view;
    if (!view) return;
    while (this.inflight) await this.inflight;
    if (patch.version !== this.version + 1) return this.resync();

    const insert = patch.insert.map((json) => PMNode.fromJSON(schema, json));
    const remote: BlockRange = { start: patch.start, delete: patch.delete, insert };
    const local = diffBlocks(this.synced, view.state.doc);

    let start = remote.start;
    if (local) {
      const localEnd = local.start + local.delete;
      const remoteEnd = remote.start + remote.delete;
      const disjoint = remoteEnd < local.start || remote.start > localEnd;
      if (!disjoint) return this.resync();
      // Remote range is in synced coordinates; shift it past local edits above it.
      if (remote.start > localEnd) start += local.insert.length - local.delete;
    }

    const doc = view.state.doc;
    const from = blockPos(doc, start);
    const to = blockPos(doc, start + remote.delete);
    const content = insert.length || doc.childCount > remote.delete ? insert : [schema.nodes.paragraph.create()];
    const tr = view.state.tr.replaceWith(from, to, content).setMeta(remoteMeta, true);
    this.synced = replaceBlocks(this.synced, { ...remote, insert: content });
    this.version = patch.version;
    view.dispatch(tr);
  }

  /** Reload the document from the core, keeping the selection roughly in place. */
  async resync(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const { text, version } = await this.backend.documentText(this.docId);
    const { doc } = parseMarkdown(text);
    const tr: Transaction = view.state.tr
      .replaceWith(0, view.state.doc.content.size, doc.content)
      .setMeta(remoteMeta, true)
      .setMeta("addToHistory", false);
    this.synced = tr.doc;
    this.version = version;
    view.dispatch(tr);
  }
}
