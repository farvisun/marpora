import { describe, expect, it } from "vitest";
import { compareItems, groupByFolder, highlight, naturalCompare, SortType, sortEntries, naturalDate, quickPath, rankQuick, splitName, summaryLines, summaryOf } from "./library";

describe("summaryOf", () => {
  it("strips Markdown syntax", () => {
    expect(summaryOf("# Title\n\nSome **bold** and [a link](x.md).\n---\n- item")).toBe(
      " Title\nSome bold and a link.\nitem",
    );
  });

  it("uses the title and summary from front matter", () => {
    const text = "---\ntitle: Notes\ndate: 2024\nsummary: About things\n  and more\n---\n\nBody";
    expect(summaryOf(text)).toBe("Notes\nAbout things\n  and more\nBody");
  });

  it("breaks lines after words only", () => {
    expect(summaryLines("one\n\ntwo \nthree")).toEqual(["one", "two", "three"]);
  });
});

describe("naturalDate", () => {
  const now = new Date(2026, 9, 28, 15, 0, 0);
  const ago = (s: number) => naturalDate(new Date(now.getTime() - s * 1000), now);
  it("reads like Typora's", () => {
    expect(ago(10)).toBe("just now");
    expect(ago(45)).toBe("1 minutes ago");
    expect(ago(5 * 60)).toBe("5 minutes ago");
    expect(ago(2 * 3600)).toBe("13:00");
    expect(ago(20 * 3600)).toBe("Yesterday");
    expect(ago(3 * 86400)).toBe("3 days ago");
    expect(naturalDate(new Date(2026, 0, 5), now)).toBe("Jan 05");
    expect(naturalDate(new Date(2024, 2, 9), now)).toBe("2024-03-09");
  });
});

describe("naturalCompare", () => {
  it("orders numbers by value and months by month", () => {
    const names = ["note 10.md", "note 2.md", "March.md", "jan.md", "Apple.md"];
    expect(names.sort(naturalCompare)).toEqual(["Apple.md", "jan.md", "March.md", "note 2.md", "note 10.md"]);
  });
});

describe("sidebar sorting", () => {
  const item = (name: string, modified: number, created: number) => ({ name, modified, created });
  const names = (xs: { name: string }[]) => xs.map((x) => x.name);
  const items = [item("b 10.md", 1, 3), item("B 9.md", 3, 1), item("a.md", 2, 2)];

  it("orders by Typora's sort types", () => {
    const by = (sort: number) => names([...items].sort(compareItems(sort)));
    expect(by(SortType.Natural)).toEqual(["a.md", "B 9.md", "b 10.md"]);
    expect(by(SortType.NaturalDescend)).toEqual(["b 10.md", "B 9.md", "a.md"]);
    expect(by(SortType.Alphabet)).toEqual(["a.md", "b 10.md", "B 9.md"]);
    expect(by(SortType.DateDescend)).toEqual(["B 9.md", "a.md", "b 10.md"]);
    expect(by(SortType.CreateDate)).toEqual(["B 9.md", "a.md", "b 10.md"]);
  });

  it("groups by folder unless told not to", () => {
    const doc = (folder: string, name: string, modified: number) => ({ folder, name, path: `${folder}/${name}`, modified, created: 0, summary: "" });
    const files = [doc("/n", "z.md", 1), doc("/n/sub", "a.md", 2), doc("/n", "b.md", 3)];
    expect(groupByFolder(files).map((g) => [g.folder, names(g.files)])).toEqual([
      ["/n", ["b.md", "z.md"]],
      ["/n/sub", ["a.md"]],
    ]);
    expect(names(groupByFolder(files, SortType.DateDescend, true)[0].files)).toEqual(["b.md", "a.md", "z.md"]);
    const entries = [{ ...item("z", 0, 0), isDirectory: true }, { ...item("a.md", 0, 0), isDirectory: false }];
    expect(names(sortEntries(entries))).toEqual(["z", "a.md"]);
    expect(names(sortEntries(entries, 0, true))).toEqual(["a.md", "z"]);
  });
});

describe("splitName", () => {
  it("keeps the extension apart, except for folders", () => {
    expect(splitName("a.b.md")).toEqual(["a.b", ".md"]);
    expect(splitName("README")).toEqual(["README", ""]);
    expect(splitName("v1.2", true)).toEqual(["v1.2", ""]);
  });
});

describe("Quick Open", () => {
  const items = [
    { name: "todo.md", path: "/home/me/notes/todo.md", modified: 1 },
    { name: "photo-todo.md", path: "/home/me/notes/sub/photo-todo.md", modified: 3 },
    { name: "plan.md", path: "/home/me/todo/plan.md", modified: 2 },
    { name: "readme.md", path: "/elsewhere/readme.md", modified: 9 },
  ];
  const rank = (q: string) => rankQuick(items, q, "/home/me/notes", "/home/me").map((i) => i.name);

  it("ranks name matches at word starts first, then folder matches", () => {
    expect(rank("todo")).toEqual(["todo.md", "photo-todo.md", "plan.md"]);
  });

  it("needs every term to match", () => {
    expect(rank("todo photo")).toEqual(["photo-todo.md"]);
  });

  it("lists the folder's files first, newest first, without a query", () => {
    expect(rank("")).toEqual(["photo-todo.md", "todo.md", "readme.md", "plan.md"]);
  });

  it("shows paths from the library folder or from home", () => {
    expect(quickPath("/home/me/notes/sub/a.md", "/home/me/notes", "/home/me")).toBe("notes/sub/");
    expect(quickPath("/home/me/todo/plan.md", "/home/me/notes", "/home/me")).toBe("~/todo/");
  });

  it("marks matched text", () => {
    expect(highlight("photo-todo", "todo")).toEqual([
      ["photo-", false],
      ["todo", true],
    ]);
  });
});
