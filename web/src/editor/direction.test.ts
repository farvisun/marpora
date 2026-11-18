// @vitest-environment jsdom
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import {
  detectDir,
  directionAt,
  directionKey,
  directionPlugin,
  savedDirections,
  setDirection,
  storeDirections,
  storedDirections,
  textHash,
  toggleDirection,
} from "./direction";
import { schema } from "./schema";

const n = schema.nodes;
const p = (text = "") => n.paragraph.create(null, text ? schema.text(text) : null);
const h = (text: string) => n.heading.create({ level: 1 }, schema.text(text));
const li = (text: string) => n.list_item.create(null, p(text));
const ul = (...items: string[]) => n.bullet_list.create(null, items.map(li));
const quote = (...paras: string[]) => n.blockquote.create(null, paras.map((t) => p(t)));

function state(...blocks: PMNode[]) {
  return EditorState.create({ doc: n.doc.create(null, blocks), plugins: [directionPlugin] });
}

/** Each decorated node as `type:dir`, in document order. */
function dirs(s: EditorState): string[] {
  return directionKey
    .getState(s)!
    .decos.find()
    .sort((a, b) => a.from - b.from || b.to - a.to)
    .map((d) => `${s.doc.nodeAt(d.from)!.type.name}:${d.spec.shown}`);
}

/** The state after selecting position `pos` and running `cmd`. */
function run(s: EditorState, pos: number, cmd: (s: EditorState, d: (tr: import("prosemirror-state").Transaction) => void) => boolean) {
  let next = s.apply(s.tr.setSelection(TextSelection.create(s.doc, pos)));
  cmd(next, (tr) => (next = next.apply(tr)));
  return next;
}

describe("detectDir", () => {
  it("follows the first letter", () => {
    expect(detectDir("سلام دنیا")).toBe("rtl");
    expect(detectDir("Hello world")).toBe("ltr");
    expect(detectDir("این React است")).toBe("rtl");
    expect(detectDir("React is یک")).toBe("ltr");
  });
  it("or most of the letters", () => {
    expect(detectDir("React یک کتابخانه خوب است")).toBe("rtl");
  });
  it("skips digits, punctuation and marks", () => {
    expect(detectDir("123 — !! سلام")).toBe("rtl");
    expect(detectDir("۱۲۳ ۴۵")).toBeNull();
    expect(detectDir("")).toBeNull();
    expect(detectDir("می‌خواهم")).toBe("rtl");
  });
  it("reads Arabic and Hebrew as right to left", () => {
    expect(detectDir("مرحبا")).toBe("rtl");
    expect(detectDir("שלום")).toBe("rtl");
  });
});

describe("direction decorations", () => {
  it("mark text blocks and the containers around them", () => {
    const s = state(h("عنوان"), p("Hello"), ul("مورد اول", "second"), quote("نقل قول"));
    expect(dirs(s)).toEqual([
      "heading:rtl",
      "paragraph:ltr",
      "bullet_list:rtl",
      "list_item:rtl",
      "paragraph:rtl",
      "list_item:ltr",
      "paragraph:ltr",
      "blockquote:rtl",
      "paragraph:rtl",
    ]);
  });

  it("let an empty block follow the one before it", () => {
    const s = state(p("سلام"), p(), p("Hi"), p());
    expect(dirs(s)).toEqual(["paragraph:rtl", "paragraph:rtl", "paragraph:ltr", "paragraph:ltr"]);
  });

  it("give a table its header row's direction", () => {
    const row = (cell: "table_header" | "table_cell", ...texts: string[]) =>
      n.table_row.create(null, texts.map((t) => n[cell].create(null, schema.text(t))));
    const table = n.table.create(null, [
      n.table_head.create(null, row("table_header", "نام", "سن")),
      n.table_body.create(null, row("table_cell", "Ali", "۳۰")),
    ]);
    const s = state(table);
    expect(dirs(s)).toEqual(["table:rtl", "table_header:rtl", "table_header:rtl", "table_cell:ltr"]);
  });

  it("follow typing, also in the block after", () => {
    let s = state(p("x"), p());
    expect(dirs(s)).toEqual(["paragraph:ltr", "paragraph:ltr"]);
    s = s.apply(s.tr.insertText("سلام دوستان من", 1, 2));
    expect(dirs(s)).toEqual(["paragraph:rtl", "paragraph:rtl"]);
  });

  it("stay what a full build gives, through edits", () => {
    let s = state(p("Hello"), p(), ul("مورد", "item"), p("x"), p(), quote("Quote"));
    const edits: ((s: EditorState) => import("prosemirror-state").Transaction)[] = [
      (s) => s.tr.insertText("سلام عزیزم", 1, 6),
      (s) => s.tr.split(3),
      (s) => s.tr.insertText("کلمه", s.doc.content.size - 3),
      (s) => s.tr.delete(1, 4),
      (s) => s.tr.insert(0, p("שלום")),
      (s) => s.tr.join(s.doc.child(0).nodeSize),
    ];
    for (const edit of edits) {
      s = s.apply(edit(s));
      expect(dirs(s)).toEqual(dirs(EditorState.create({ doc: s.doc, plugins: [directionPlugin] })));
    }
  });

  it("never touch code blocks", () => {
    const s = state(n.code_block.create(null, schema.text("سلام")), p("سلام"));
    expect(dirs(s)).toEqual(["paragraph:rtl"]);
  });
});

describe("directions set by hand", () => {
  it("override the text and stay through typing", () => {
    let s = run(state(p("سلام"), p("Hi")), 2, setDirection("ltr"));
    expect(dirs(s)).toEqual(["paragraph:ltr", "paragraph:ltr"]);
    expect(directionAt(s, 2)).toEqual({ dir: "ltr", manual: true });
    s = s.apply(s.tr.insertText(" دنیا", 5));
    expect(dirs(s)[0]).toBe("paragraph:ltr");
    expect(savedDirections(s)).toEqual({ [textHash("سلام دنیا")]: "ltr" });
  });

  it("clear with auto", () => {
    let s = run(state(p("سلام")), 2, setDirection("ltr"));
    s = run(s, 2, setDirection(null));
    expect(dirs(s)).toEqual(["paragraph:rtl"]);
    expect(savedDirections(s)).toEqual({});
  });

  it("toggle from what shows", () => {
    let s = run(state(p("Hello")), 2, toggleDirection);
    expect(directionAt(s, 2)).toEqual({ dir: "rtl", manual: true });
    s = run(s, 2, toggleDirection);
    expect(directionAt(s, 2)).toEqual({ dir: "ltr", manual: true });
  });

  it("come back by text when loaded or replaced from outside", () => {
    let s = state(p("Hello"), p("سلام"));
    s = s.apply(s.tr.setMeta(directionKey, { load: { [textHash("سلام")]: "ltr" } }));
    expect(dirs(s)).toEqual(["paragraph:ltr", "paragraph:ltr"]);
    // A reload from disk replaces every block.
    s = s.apply(s.tr.replaceWith(0, s.doc.content.size, [p("Hello"), p("سلام")]).setMeta("marpora-remote", true));
    expect(dirs(s)).toEqual(["paragraph:ltr", "paragraph:ltr"]);
  });

  it("are not picked up by typing text that matches", () => {
    let s = state(p("Hello"), p());
    s = s.apply(s.tr.setMeta(directionKey, { load: { [textHash("سلام")]: "ltr" } }));
    s = s.apply(s.tr.insertText("سلام", 8));
    expect(dirs(s)[1]).toBe("paragraph:rtl");
  });
});

describe("stored directions", () => {
  it("round-trip per file and clear when none are left", () => {
    let s = run(state(p("سلام"), p("Hi")), 2, setDirection("ltr"));
    storeDirections("/notes/a.md", s);
    expect(storedDirections("/notes/a.md")).toEqual({ [textHash("سلام")]: "ltr" });
    expect(storedDirections("/notes/b.md")).toEqual({});
    s = run(s, 2, setDirection(null));
    storeDirections("/notes/a.md", s);
    expect(localStorage.getItem("marpora.dir:/notes/a.md")).toBeNull();
  });
  it("ignore untitled documents and bad data", () => {
    expect(storedDirections(null)).toEqual({});
    localStorage.setItem("marpora.dir:/x.md", "{not json");
    expect(storedDirections("/x.md")).toEqual({});
    localStorage.setItem("marpora.dir:/y.md", JSON.stringify({ a: "rtl", b: "up" }));
    expect(storedDirections("/y.md")).toEqual({ a: "rtl" });
  });
});
