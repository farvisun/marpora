import { describe, expect, it } from "vitest";
import { highlight, naturalCompare, naturalDate, quickPath, rankQuick, splitName, summaryLines, summaryOf } from "./library";

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
