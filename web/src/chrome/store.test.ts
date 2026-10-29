import { describe, expect, it } from "vitest";
import { schema } from "../editor/schema";
import { countDoc, countText, docText } from "./store";

const n = schema.nodes;
const para = (text = "") => n.paragraph.create(null, text ? schema.text(text) : null);

describe("countDoc", () => {
  it("counts as the document's whole text would", () => {
    const docs = [
      n.doc.create(null, para()),
      n.doc.create(null, [para(), para()]),
      n.doc.create(null, [
        n.heading.create({ level: 1 }, schema.text("Title here")),
        para("One two, three’s four 漢字"),
        n.horizontal_rule.create(),
        para(),
        n.bullet_list.create(null, [
          n.list_item.create(null, [para("item one"), para("more")]),
          n.list_item.create({ checked: true }, para("done")),
        ]),
        n.code_block.create(null, schema.text("let a = 1;\nlet b = 2;")),
        n.paragraph.create(null, [schema.text("before"), n.hard_break.create(), schema.text("after")]),
      ]),
    ];
    for (const doc of docs) {
      expect(countDoc(doc, "two")).toEqual(countText(docText(doc), "two"));
      // Again, from the cache.
      expect(countDoc(doc)).toEqual(countText(docText(doc)));
    }
  });
});
