// `node test/bench.mjs`: editor timings in Playwright WebKit (the engine of the app's
// WKWebView), against a production build served by `vite preview` (see
// docs/benchmarks.md). Prints a Markdown table.

import { readFileSync } from "node:fs";
import { webkit } from "playwright";

const URL = process.env.URL ?? "http://localhost:4173/";
const FIXTURE = readFileSync(new globalThis.URL("../../fixtures/docs/features.md", import.meta.url), "utf8");

/**
 * A document repeating the fixture while `fits` holds, as the Rust bench does, with one
 * `[TOC]`: a table of contents in every repeat would list every heading hundreds of
 * times over, which no real document does.
 */
function documentWhile(fits) {
  let out = "";
  for (let i = 1; fits(out); i++) {
    const part = i === 1 ? FIXTURE : FIXTURE.replace("[TOC]\n", "");
    out += `${part.replaceAll("# ", `# Part ${i}: `)}\n`;
  }
  return out;
}
const lines = documentWhile((s) => s.split("\n").length < 20_000);
const big = documentWhile((s) => s.length < 5 * 1024 * 1024);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const ms = (t) => `${t.toFixed(1)} ms`;
const rows = [];
const add = (what, t) => {
  rows.push([what, t]);
  console.error(`${what}: ${t}`);
};

const browser = await webkit.launch();
const page = async () => {
  const p = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  // When the editor is up: main.tsx exposes `window.marpora` last.
  await p.addInitScript(() => {
    let value;
    Object.defineProperty(window, "marpora", {
      configurable: true,
      get: () => value,
      set: (v) => {
        value = v;
        window.marporaReadyAt = performance.now();
      },
    });
  });
  return p;
};

// Startup: from navigation to an editable document.
const starts = [];
for (let i = 0; i < 7; i++) {
  const p = await page();
  await p.goto(URL);
  await p.waitForFunction(() => window.marporaReadyAt !== undefined);
  starts.push(await p.evaluate(() => window.marporaReadyAt));
  await p.close();
}
add("Startup to an editable document (median of 7)", ms(median(starts)));

/** Time to show `text` in the editor: parsed (WASM), laid out, one frame drawn. */
const open = (p, text) =>
  p.evaluate(async (text) => {
    const m = window.marpora;
    const start = performance.now();
    await m.backend.setText(1, text);
    await m.sync.resync();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    return performance.now() - start;
  }, text);

/** Keystroke to frame: keydown until the frame after it, for `count` typed letters. */
async function typing(p, count) {
  await p.evaluate(() => {
    const { view } = window.marpora;
    // Into the middle of the document, in a paragraph.
    let at = 0;
    view.state.doc.descendants((n, pos) => {
      if (!at && n.type.name === "paragraph" && pos > view.state.doc.content.size / 2) at = pos + 1;
    });
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, at)).scrollIntoView());
    view.focus();
    window.marporaLatencies = [];
    document.addEventListener(
      "keydown",
      () => {
        const start = performance.now();
        requestAnimationFrame(() => setTimeout(() => window.marporaLatencies.push(performance.now() - start)));
      },
      true,
    );
  });
  await p.keyboard.type("a".repeat(count), { delay: 25 });
  await p.waitForTimeout(200);
  return p.evaluate(() => window.marporaLatencies);
}

for (const [name, text, keys] of [
  [`20k lines (${Math.round(lines.length / 1024)} KB)`, lines, 150],
  [`5 MB`, big, 30],
]) {
  const p = await page();
  await p.goto(URL);
  await p.waitForFunction(() => window.marporaReadyAt !== undefined);
  add(`Open, ${name}`, ms(await open(p, text)));
  const latencies = await typing(p, keys);
  add(`Keystroke to frame, ${name}: p50 / p99`, `${ms(pct(latencies, 50))} / ${ms(pct(latencies, 99))}`);
  await p.close();
}
await browser.close();

console.log("| Editor (WebKit, production build) | Time |\n|---|---|");
for (const [what, t] of rows) console.log(`| ${what} | ${t} |`);
