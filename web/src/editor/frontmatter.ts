// The YAML front matter keys Typora reads: `typora-root-url`, which roots image paths
// starting with `/`, and `typora-copy-images-to`, where pasted images go.

import type { Node as PMNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { schema } from "./schema";

const line = (key: string) => new RegExp(`^${key.replace(/[-.]/g, "\\$&")}\\s*:(.*)$`);

/** The value of `key` in the document's front matter: one `key: value` line, unquoted. */
export function frontMatterValue(doc: PMNode, key: string): string | null {
  const first = doc.firstChild;
  if (first?.type !== schema.nodes.front_matter) return null;
  for (const l of first.textContent.split("\n")) {
    const m = line(key).exec(l);
    if (!m) continue;
    const v = m[1].trim();
    const unquoted = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
    return unquoted || null;
  }
  return null;
}

/** `value` as a YAML scalar, quoted only when it has to be. */
function scalar(value: string): string {
  return /^[\s'"{}[\]&*!|>%@`#,?:-]|: | #|\s$/.test(value) ? JSON.stringify(value) : value;
}

/** Set `key` in the front matter (adding it, and the front matter, if missing), or
 * remove it when `value` is null. Null when there is nothing to change. */
export function setFrontMatterValue(state: EditorState, key: string, value: string | null): Transaction | null {
  const first = state.doc.firstChild;
  const has = first?.type === schema.nodes.front_matter;
  if (!has && value === null) return null;
  const lines = has ? first!.textContent.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1) : [];
  const at = lines.findIndex((l) => line(key).test(l));
  const entry = value === null ? null : `${key}: ${scalar(value)}`;
  if (at >= 0 && entry !== null) lines[at] = entry;
  else if (at >= 0) lines.splice(at, 1);
  else if (entry !== null) lines.push(entry);
  else return null;
  const text = lines.join("\n");
  const content = text ? schema.text(text) : null;
  if (!has) return state.tr.insert(0, schema.nodes.front_matter.create(null, content));
  return state.tr.replaceWith(1, 1 + first!.content.size, content ?? []);
}

/** `src` under the image root `root`, as Typora resolves `/…` paths with
 * `typora-root-url`; other paths are left alone. */
export function rootedSrc(src: string, root: string | null): string {
  if (!root || !src.startsWith("/") || src.startsWith("//")) return src;
  return root.replace(/\/+$/, "") + src;
}
