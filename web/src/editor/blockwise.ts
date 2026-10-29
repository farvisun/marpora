// Decorations kept across transactions and built again only for the top-level blocks a
// transaction touched. Building them for the whole document on each keystroke was most
// of the typing time in long documents (docs/benchmarks.md).

import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { type Decoration, DecorationSet } from "prosemirror-view";

/** The decorations of the blocks between `from` and `to` of `doc`. */
export type Build = (doc: PMNode, from: number, to: number) => Decoration[];

/** The top-level blocks around `from`..`to`, as a range of `doc`. */
function blocksAround(doc: PMNode, from: number, to: number): [number, number] {
  const clamp = (pos: number) => doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  const $from = clamp(from);
  const $to = clamp(to);
  return [$from.depth ? $from.before(1) : $from.pos, $to.depth ? $to.after(1) : $to.pos];
}

/** What `tr` changed, as ranges of its document, with `also` (positions in it). */
export function changedRanges(tr: Transaction, also: number[] = []): [number, number][] {
  const ranges: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_from, _to, start, end) => ranges.push([after.map(start, -1), after.map(end, 1)]));
  });
  for (const pos of also) ranges.push([pos, pos]);
  return ranges;
}

/** All of `doc`'s decorations. */
export function buildAll(doc: PMNode, build: Build): DecorationSet {
  return DecorationSet.create(doc, build(doc, 0, doc.content.size));
}

/** `set` mapped through `tr`, with the blocks around `ranges` built again. */
export function rebuild(set: DecorationSet, tr: Transaction, ranges: [number, number][], build: Build): DecorationSet {
  let next = set.map(tr.mapping, tr.doc);
  for (const [from, to] of ranges) {
    const [start, end] = blocksAround(tr.doc, from, to);
    const stale = next.find(start, end).filter((d) => d.from >= start && d.to <= end);
    next = next.remove(stale).add(tr.doc, build(tr.doc, start, end));
  }
  return next;
}
