// @vitest-environment jsdom
import { EditorState, type Transaction, TextSelection } from "prosemirror-state";
import type { Decoration } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { htmlPlugins } from "./html";
import { schema } from "./schema";
import { tasksPlugin } from "./tasks";

const tag = (html: string) => schema.nodes.html_inline.create({ html });
const para = (...content: (string | ReturnType<typeof tag>)[]) =>
  schema.nodes.paragraph.create(null, content.map((c) => (typeof c === "string" ? schema.text(c) : c)));

/** The inline decorations as comparable strings. */
function decorations(state: EditorState): string[] {
  const set = htmlPlugins[0].getState(state)!;
  return set
    .find()
    .map((d: Decoration) => `${d.from}-${d.to} ${JSON.stringify((d as unknown as { type: { attrs: unknown } }).type.attrs)}`)
    .sort();
}

describe("inline HTML decorations", () => {
  it("stay what a full rebuild gives, through edits and cursor moves", () => {
    const doc = schema.nodes.doc.create(
      null,
      Array.from({ length: 6 }, (_, i) => para(`p${i} `, tag("<mark>"), "marked", tag("</mark>"), " end")),
    );
    let state = EditorState.create({ doc, plugins: htmlPlugins });
    const steps: ((s: EditorState) => Transaction)[] = [
      // Into the second paragraph's mark: its tags show.
      (s) => s.tr.setSelection(TextSelection.create(s.doc, s.doc.child(0).nodeSize + 7)),
      (s) => s.tr.insertText("xy"),
      // Out to the last paragraph.
      (s) => s.tr.setSelection(TextSelection.create(s.doc, s.doc.content.size - 2)),
      // A new pair in the first paragraph.
      (s) => s.tr.insert(2, [tag("<kbd>"), schema.text("K"), tag("</kbd>")]),
      // The third paragraph removed.
      (s) => {
        let pos = 0;
        for (let i = 0; i < 2; i++) pos += s.doc.child(i).nodeSize;
        return s.tr.delete(pos, pos + s.doc.child(2).nodeSize);
      },
      // An opening tag deleted: its pair is gone.
      (s) => s.tr.delete(4, 5),
    ];
    for (const step of steps) {
      state = state.apply(step(state));
      const fresh = EditorState.create({ doc: state.doc, selection: state.selection, plugins: htmlPlugins });
      expect(decorations(state)).toEqual(decorations(fresh));
    }
    expect(decorations(state).length).toBeGreaterThan(0);
  });
});

describe("task checkboxes", () => {
  const item = (checked: boolean | null, text: string) =>
    schema.nodes.list_item.create({ checked }, para(text));
  const list = () => schema.nodes.bullet_list.create(null, [item(false, "a"), item(true, "b"), item(null, "c")]);
  const widgets = (state: EditorState) =>
    tasksPlugin
      .getState(state)!
      .find()
      .map((d: Decoration) => `${d.from} ${d.spec.key}`)
      .sort();

  it("stay what a full rebuild gives, through edits", () => {
    let state = EditorState.create({ doc: schema.nodes.doc.create(null, [para("x"), list(), list()]), plugins: [tasksPlugin] });
    const first = 3;
    const steps: ((s: EditorState) => Transaction)[] = [
      (s) => s.tr.insertText("typed", first + 3),
      // Ticked, as a click does.
      (s) => s.tr.setNodeMarkup(first + 1, null, { checked: true }),
      // A task added to the second list.
      (s) => s.tr.insert(s.doc.content.size - 1, item(false, "d")),
      // The first list removed.
      (s) => s.tr.delete(first, first + s.doc.child(1).nodeSize),
    ];
    for (const step of steps) {
      state = state.apply(step(state));
      const fresh = EditorState.create({ doc: state.doc, plugins: [tasksPlugin] });
      expect(widgets(state)).toEqual(widgets(fresh));
    }
    expect(widgets(state)).toHaveLength(3);
  });
});
