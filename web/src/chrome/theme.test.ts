import { describe, expect, it } from "vitest";
import { rebaseCss } from "./theme";

const resolve = (base: string, rel: string) => `asset:${base.replace(/[^/]*$/, "")}${rel}`;

describe("rebaseCss", () => {
  it("rewrites relative url() and @import, keeps absolute ones", () => {
    const css = [
      `@import "github/fonts.css";`,
      `@font-face { src: url('./github/a.woff?v=2#x') format("woff"), url(data:font/woff;base64,AA); }`,
      `body { background: url(https://example.com/a.png); mask: url(#m); }`,
    ].join("\n");
    expect(rebaseCss(css, "/T/themes", resolve)).toBe(
      [
        `@import "asset:/T/themes/github/fonts.css";`,
        `@font-face { src: url('asset:/T/themes/./github/a.woff') format("woff"), url(data:font/woff;base64,AA); }`,
        `body { background: url(https://example.com/a.png); mask: url(#m); }`,
      ].join("\n"),
    );
  });
});
