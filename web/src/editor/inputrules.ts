// Typora's as-you-type Markdown: block prefixes convert on space, delimiter pairs turn
// into marks when closed, and fences/tables/rules convert on Enter (see keymap.ts).

import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import type { MarkType, Node as PMNode } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import { getFlavor } from "../md";
import { schema } from "./schema";

const n = schema.nodes;
const m = schema.marks;

/**
 * `**text**` → strong, etc. Group 1 is the delimited span (a suffix of the match, which
 * may start with one guard character); the last group is the content.
 */
function markRule(regexp: RegExp, type: MarkType, attrs?: (match: RegExpMatchArray) => Record<string, unknown>) {
  return new InputRule(regexp, (state, match, start, end) => {
    const span = match[1];
    const content = match[match.length - 1];
    if (!span || !content || rangeHasCode(state, start, end)) return null;
    const delim = (span.length - content.length) / 2;
    // `end` excludes the character just typed (the last closing delimiter).
    const open = start + match[0].length - span.length;
    const textStart = open + delim;
    const textEnd = textStart + content.length;
    const tr = state.tr.delete(textEnd, end).delete(open, textStart);
    tr.addMark(open, open + content.length, type.create(attrs?.(match)));
    tr.removeStoredMark(type);
    return tr;
  });
}

function rangeHasCode(state: EditorState, from: number, to: number): boolean {
  let code = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (m.code.isInSet(node.marks)) code = true;
  });
  return code;
}

/** Replace group 1 of the match (a suffix of it) with an inline node. */
function nodeRule(regexp: RegExp, make: (match: RegExpMatchArray) => PMNode) {
  return new InputRule(regexp, (state, match, start, end) => {
    if (rangeHasCode(state, start, end)) return null;
    const from = start + match[0].length - match[1].length;
    return state.tr.replaceWith(from, end, make(match));
  });
}

/** `[ ] ` / `[x] ` at the start of a list item turns it into a task. */
const taskRule = new InputRule(/^\[( |x|X)\]\s$/, (state, match, start, end) => {
  const $start = state.doc.resolve(start);
  const depth = $start.depth - 1;
  if (depth < 1 || $start.node(depth).type !== n.list_item || $start.index(depth) !== 0) return null;
  return state.tr
    .delete(start, end)
    .setNodeMarkup($start.before(depth), null, { checked: match[1] !== " " });
});

export function markdownInputRules() {
  const flavor = getFlavor();
  const optional = (on: boolean, rule: InputRule) => (on ? [rule] : []);
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, n.heading, (match) => ({ level: match[1].length })),
      wrappingInputRule(/^\s*>\s$/, n.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list, (match) => ({ bullet: match[1] })),
      wrappingInputRule(
        /^(\d+)([.)])\s$/,
        n.ordered_list,
        (match) => ({ start: Number(match[1]), delim: match[2] }),
        (match, node) => node.childCount + node.attrs.start === Number(match[1]),
      ),
      taskRule,
      markRule(/(?:^|[^*\\])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/, m.strong),
      markRule(/(?:^|[^_\w\\])(__([^_\s](?:[^_]*[^_\s])?)__)$/, m.strong, () => ({ markup: "__" })),
      markRule(/(?:^|[^*\\])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/, m.em),
      markRule(/(?:^|[^_\w\\])(_([^_\s](?:[^_]*[^_\s])?)_)$/, m.em, () => ({ markup: "_" })),
      markRule(/(?:^|[^`\\])(`([^`]+)`)$/, m.code),
      markRule(/(?:^|[^~\\])(~~([^~\s](?:[^~]*[^~\s])?)~~)$/, m.strike),
      ...optional(flavor.highlight, markRule(/(?:^|[^=\\])(==([^=\s](?:[^=]*[^=\s])?)==)$/, m.highlight)),
      ...optional(
        flavor.superscript,
        markRule(/(?:^|[^^\\])(\^([^^\s](?:[^^]*[^^\s])?)\^)$/, m.sup),
      ),
      ...optional(
        flavor.subscript,
        markRule(/(?:^|[^~\\])(~([^~\s](?:[^~]*[^~\s])?)~)$/, m.sub),
      ),
      ...optional(
        flavor.inlineMath,
        nodeRule(/(?:^|[^$\\])(\$([^$\s](?:[^$]*[^$\s])?)\$)$/, (match) =>
          n.math_inline.create({ tex: match[2] }),
        ),
      ),
      nodeRule(/(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\))$/, (match) =>
        n.image.create({ alt: match[2], src: match[3], title: match[4] ?? "" }),
      ),
      nodeRule(/(?:^|[^!])(\[([^\]]+)\]\(([^)\s]*)(?:\s+"([^"]*)")?\))$/, (match) =>
        schema.text(match[2], [m.link.create({ href: match[3], title: match[4] ?? "" })]),
      ),
    ],
  });
}
