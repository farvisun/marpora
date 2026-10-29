import { describe, expect, it } from "vitest";
import { cleanAnswer } from "./ai";

describe("cleanAnswer", () => {
  it("unwraps a reply fenced as a whole", () => {
    expect(cleanAnswer("```markdown\n# A\n\nb\n```\n")).toBe("# A\n\nb");
    expect(cleanAnswer("```\nplain\n```")).toBe("plain");
  });
  it("keeps fences inside the reply", () => {
    const md = "Text\n\n```js\nx\n```";
    expect(cleanAnswer(md)).toBe(md);
    expect(cleanAnswer("```js\nx\n```")).toBe("```js\nx\n```");
  });
  it("trims blank lines around it", () => {
    expect(cleanAnswer("\n\nHello  \n")).toBe("Hello");
    expect(cleanAnswer("  indented")).toBe("  indented");
  });
});
