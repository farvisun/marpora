// ProseMirror schema whose DOM mirrors Typora's, so Typora themes style it unchanged.
//
// Node and mark names, attrs and mark order must match crates/md (parse.rs,
// serialize.rs and pm::MARK_ORDER): documents cross that boundary as JSON.

import { Schema, type DOMOutputSpec, type Node as PMNode } from "prosemirror-model";

const block = (mdtype: string, extraClass = "") => ({
  class: `md-end-block${extraClass ? " " + extraClass : ""}`,
  mdtype,
});

/** Text-only blocks edited as source (code, math, front matter, raw HTML). */
const sourceBlock = {
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  group: "block",
};

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },

    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: (): DOMOutputSpec => ["p", block("paragraph", "md-p"), 0],
    },

    heading: {
      group: "block",
      content: "inline*",
      defining: true,
      attrs: { level: { default: 1 }, setext: { default: false } },
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node): DOMOutputSpec => [`h${node.attrs.level}`, block("heading", "md-heading"), 0],
    },

    blockquote: {
      group: "block",
      content: "block+",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: (): DOMOutputSpec => ["blockquote", { mdtype: "blockquote" }, 0],
    },

    bullet_list: {
      group: "block",
      content: "list_item+",
      attrs: { tight: { default: true }, bullet: { default: "-" } },
      parseDOM: [{ tag: "ul" }],
      toDOM: (node): DOMOutputSpec => [
        "ul",
        { class: "ul-list", mdtype: "list", "data-mark": node.attrs.bullet },
        0,
      ],
    },

    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { tight: { default: true }, start: { default: 1 }, delim: { default: "." } },
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (dom: HTMLElement) => ({ start: Number(dom.getAttribute("start") ?? 1) }),
        },
      ],
      toDOM: (node): DOMOutputSpec => [
        "ol",
        { class: "ol-list", mdtype: "list", start: node.attrs.start, delimiter: node.attrs.delim },
        0,
      ],
    },

    list_item: {
      content: "block+",
      defining: true,
      attrs: { checked: { default: null } },
      parseDOM: [{ tag: "li" }],
      // The checkbox is a widget decoration (see tasks.ts) so it sits before the
      // paragraph as `li > input + p`, like Typora.
      toDOM: (node): DOMOutputSpec => {
        const task = node.attrs.checked !== null;
        const cls = task
          ? `md-list-item md-task-list-item task-list-item${node.attrs.checked ? " task-list-done" : " task-list-not-done"}`
          : "md-list-item";
        return ["li", { class: cls, mdtype: "list_item" }, 0];
      },
    },

    code_block: {
      ...sourceBlock,
      attrs: { info: { default: "" }, fence: { default: "```" } },
      parseDOM: [
        {
          tag: "pre",
          preserveWhitespace: "full",
          getAttrs: (dom: HTMLElement) => ({ info: dom.getAttribute("lang") ?? "" }),
        },
      ],
      toDOM: (node): DOMOutputSpec => [
        "pre",
        {
          ...block("fences", "md-fences"),
          lang: langOf(node),
          spellcheck: "false",
        },
        [
          "div",
          { class: "CodeMirror cm-s-inner" },
          ["div", { class: "CodeMirror-lines" }, ["div", { class: "CodeMirror-code" }, 0]],
        ],
      ],
    },

    math_block: {
      ...sourceBlock,
      toDOM: (): DOMOutputSpec => [
        "div",
        { ...block("math_block", "mathjax-block md-math-block md-rawblock"), spellcheck: "false" },
        ["pre", { class: "md-rawblock-input" }, 0],
      ],
    },

    html_block: {
      ...sourceBlock,
      toDOM: (): DOMOutputSpec => [
        "div",
        { ...block("html_block", "md-htmlblock md-rawblock"), spellcheck: "false" },
        ["pre", { class: "md-rawblock-input" }, 0],
      ],
    },

    /** Source with no editor representation, e.g. link reference definitions. */
    raw_block: {
      ...sourceBlock,
      toDOM: (): DOMOutputSpec => [
        "pre",
        { ...block("raw_block", "md-rawblock md-raw"), spellcheck: "false" },
        0,
      ],
    },

    front_matter: {
      ...sourceBlock,
      toDOM: (): DOMOutputSpec => [
        "pre",
        { ...block("meta_block", "md-meta-block"), spellcheck: "false" },
        0,
      ],
    },

    horizontal_rule: {
      group: "block",
      attrs: { markup: { default: "---" } },
      parseDOM: [{ tag: "hr" }],
      toDOM: (): DOMOutputSpec => ["hr"],
    },

    toc: {
      group: "block",
      atom: true,
      selectable: true,
      toDOM: (): DOMOutputSpec => ["div", { class: "md-toc md-end-block", mdtype: "toc" }],
    },

    table: {
      group: "block",
      content: "table_head table_body",
      isolating: true,
      parseDOM: [{ tag: "table" }],
      toDOM: (): DOMOutputSpec => [
        "figure",
        { class: "md-table-fig", mdtype: "table" },
        ["table", { class: "md-table" }, 0],
      ],
    },
    table_head: {
      content: "table_row",
      parseDOM: [{ tag: "thead" }],
      toDOM: (): DOMOutputSpec => ["thead", 0],
    },
    table_body: {
      content: "table_row*",
      parseDOM: [{ tag: "tbody" }],
      toDOM: (): DOMOutputSpec => ["tbody", 0],
    },
    table_row: {
      content: "(table_header | table_cell)+",
      parseDOM: [{ tag: "tr" }],
      toDOM: (): DOMOutputSpec => ["tr", 0],
    },
    table_header: cell("th"),
    table_cell: cell("td"),

    footnote_def: {
      group: "block",
      content: "block+",
      attrs: { label: { default: "" } },
      toDOM: (node): DOMOutputSpec => [
        "div",
        { class: "md-def-footnote footnote-line", mdtype: "def_footnote", "data-label": node.attrs.label },
        0,
      ],
    },

    text: { group: "inline" },

    soft_break: {
      group: "inline",
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br.md-soft-break" }],
      toDOM: (): DOMOutputSpec => ["br", { class: "md-soft-break" }],
    },

    hard_break: {
      group: "inline",
      inline: true,
      selectable: false,
      attrs: { markup: { default: "\\" } },
      parseDOM: [{ tag: "br" }],
      toDOM: (): DOMOutputSpec => ["br"],
    },

    image: {
      group: "inline",
      inline: true,
      atom: true,
      draggable: true,
      attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } },
      parseDOM: [
        {
          tag: "img[src]",
          getAttrs: (dom: HTMLElement) => ({
            src: dom.getAttribute("src") ?? "",
            alt: dom.getAttribute("alt") ?? "",
            title: dom.getAttribute("title") ?? "",
          }),
        },
      ],
      toDOM: (node): DOMOutputSpec => [
        "span",
        { class: "md-image", "md-inline": "image" },
        ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title || null }],
      ],
    },

    math_inline: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { tex: { default: "" }, display: { default: false } },
      toDOM: (node): DOMOutputSpec => [
        "span",
        { class: "md-inline-math", "md-inline": "math" },
        node.attrs.tex,
      ],
    },

    html_inline: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { html: { default: "" } },
      toDOM: (node): DOMOutputSpec => [
        "span",
        { class: "md-html-inline md-raw-inline", "md-inline": "html" },
        node.attrs.html,
      ],
    },

    footnote_ref: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { label: { default: "" } },
      toDOM: (node): DOMOutputSpec => [
        "sup",
        { class: "md-footnote", "md-inline": "footnote" },
        ["a", { name: `ref-footnote-${node.attrs.label}` }, node.attrs.label],
      ],
    },
  },

  // Order matters: ProseMirror sorts a node's marks by it, and crates/md uses the same
  // order (pm::MARK_ORDER) for nesting when serializing.
  marks: {
    link: {
      attrs: {
        href: { default: "" },
        title: { default: "" },
        kind: { default: "inline" },
        ref: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom: HTMLElement) => ({
            href: dom.getAttribute("href") ?? "",
            title: dom.getAttribute("title") ?? "",
          }),
        },
      ],
      toDOM: (mark): DOMOutputSpec => [
        "a",
        { href: mark.attrs.href, title: mark.attrs.title || null, "md-inline": "url" },
        0,
      ],
    },
    em: {
      attrs: { markup: { default: "*" } },
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: (): DOMOutputSpec => ["em", 0],
    },
    strong: {
      attrs: { markup: { default: "**" } },
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: (): DOMOutputSpec => ["strong", 0],
    },
    strike: {
      parseDOM: [{ tag: "del" }, { tag: "s" }],
      toDOM: (): DOMOutputSpec => ["del", 0],
    },
    highlight: {
      parseDOM: [{ tag: "mark" }],
      toDOM: (): DOMOutputSpec => ["mark", 0],
    },
    sup: {
      excludes: "sub",
      parseDOM: [{ tag: "sup" }],
      toDOM: (): DOMOutputSpec => ["sup", 0],
    },
    sub: {
      excludes: "sup",
      parseDOM: [{ tag: "sub" }],
      toDOM: (): DOMOutputSpec => ["sub", 0],
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: (): DOMOutputSpec => ["code", 0],
    },
  },
});

function cell(tag: "th" | "td") {
  return {
    content: "inline*",
    isolating: true,
    attrs: { align: { default: null } },
    parseDOM: [{ tag }],
    toDOM: (node: PMNode): DOMOutputSpec => [
      tag,
      node.attrs.align ? { style: `text-align: ${node.attrs.align}` } : {},
      0,
    ],
  };
}

/** Language of a fence: the first word of its info string. */
export function langOf(node: PMNode): string {
  return String(node.attrs.info ?? "").trim().split(/\s+/)[0] ?? "";
}
