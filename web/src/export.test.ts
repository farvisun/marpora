import { describe, expect, it } from "vitest";
import { relative } from "./export";

describe("relative", () => {
  it("walks up and down between directories", () => {
    expect(relative("/a/b", "/a/b/img.png")).toBe("img.png");
    expect(relative("/a/out", "/a/b/img.png")).toBe("../b/img.png");
    expect(relative("/x/y", "/a/b/img.png")).toBe("../../a/b/img.png");
    expect(relative("/a/b/c", "/a/b/img.png")).toBe("../img.png");
  });
});
