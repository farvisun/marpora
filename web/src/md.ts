// Markdown ⇄ ProseMirror via the marpora-md WASM module (same code as the Rust core).

import init, { parse as wasmParse, serializeBlocks as wasmSerializeBlocks } from "./md/pkg/marpora_md.js";
import wasmUrl from "./md/pkg/marpora_md_bg.wasm?url";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "./editor/schema";

let ready: Promise<unknown> | null = null;

/** Optional syntax (crates/md `Flavor`). Typora's defaults: all off. */
export interface Flavor {
  inlineMath: boolean;
  highlight: boolean;
  subscript: boolean;
  superscript: boolean;
}

let flavor: Flavor = { inlineMath: false, highlight: false, subscript: false, superscript: false };
let flavorJson = JSON.stringify(flavor);

/** Set once per window, before the editor is created (like Typora, changes need a reload). */
export function setFlavor(f: Partial<Flavor>) {
  flavor = { ...flavor, ...f };
  flavorJson = JSON.stringify(flavor);
}

export function getFlavor(): Readonly<Flavor> {
  return flavor;
}

export function initMarkdown(): Promise<unknown> {
  ready ??= init({ module_or_path: wasmUrl });
  return ready;
}

export interface ParsedDoc {
  doc: PMNode;
  /** Byte ranges of the top-level blocks in the UTF-8 source. */
  blocks: [number, number][];
}

export function parseMarkdown(src: string): ParsedDoc {
  const { doc, blocks } = JSON.parse(wasmParse(src, flavorJson));
  return { doc: PMNode.fromJSON(schema, doc), blocks };
}

/** Markdown for each top-level block, in order. */
export function serializeBlocks(nodes: readonly PMNode[]): string[] {
  if (nodes.length === 0) return [];
  return wasmSerializeBlocks(JSON.stringify(nodes.map((n) => n.toJSON())));
}

export function serializeDoc(doc: PMNode): string {
  const blocks: PMNode[] = [];
  doc.forEach((n) => blocks.push(n));
  const md = serializeBlocks(blocks).join("\n\n");
  return md ? md + "\n" : md;
}
