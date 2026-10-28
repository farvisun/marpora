// End-to-end editing checks in WebKit against the in-memory backend (vite dev server).
// `node test/e2e.mjs` — exits non-zero on failure.
import { webkit } from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(process.env.URL ?? "http://localhost:1420/");
await page.waitForSelector("#write");

const text = () => page.evaluate(async () => {
  await window.marpora.sync.flush();
  return (await window.marpora.backend.documentText(1)).text;
});
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n     " + detail}`);
  if (!ok) failures++;
};

// Start with an empty document.
await page.evaluate(() => {
  const { view } = window.marpora;
  view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
});
await text();
await page.click("#write");

await page.keyboard.type("# Title");
await page.keyboard.press("Enter");
await page.keyboard.type("Some **bold** and *em* and `code` here.");
let md = await text();
check("heading and inline marks", md.includes("# Title\n\nSome **bold** and *em* and `code` here."), JSON.stringify(md));
check("heading DOM", await page.locator("#write > h1.md-heading").count() === 1);
check("strong DOM", await page.locator("#write p strong").textContent() === "bold");

// Syntax reveal: cursor inside bold shows ** delimiters.
await page.evaluate(() => {
  const { view } = window.marpora;
  let pos = 0;
  view.state.doc.descendants((n, p) => { if (n.isText && n.text === "bold") pos = p + 2; });
  view.dispatch(view.state.tr.setSelection(window.marpora.view.state.selection.constructor.near(view.state.doc.resolve(pos))));
});
check("reveal shows delimiters", (await page.locator("#write .md-meta.md-before").allTextContents()).includes("**"));
await page.evaluate(() => {
  const { view } = window.marpora;
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atEnd(view.state.doc)));
});
await page.keyboard.press("Enter");

await page.keyboard.type("- one");
await page.keyboard.press("Enter");
await page.keyboard.type("two");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("> quoted");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("```js");
await page.keyboard.press("Enter");
await page.keyboard.type("let x = 1;");
await page.keyboard.press("Meta+Enter");
await page.keyboard.type("| a | b |");
await page.keyboard.press("Enter");
await page.keyboard.type("1");
md = await text();
check("list", md.includes("- one\n- two"), JSON.stringify(md));
check("quote", md.includes("> quoted"), JSON.stringify(md));
check("code fence", md.includes("```js\nlet x = 1;\n```"), JSON.stringify(md));
const keyword = await page
  .waitForSelector(".md-fences .cm-keyword", { timeout: 5000 })
  .then((el) => el.textContent())
  .catch(() => null);
check("fence highlighted", keyword === "let", String(keyword));
check("table", /\| a +\| b +\|\n\| -+ \| -+ \|\n\| 1 +\| +\|/.test(md), JSON.stringify(md));

// Undo goes back through the history and the backend follows.
await page.keyboard.press("Meta+z");
md = await text();
check("undo syncs", !md.includes("| 1"), JSON.stringify(md));

// Language box under the focused fence.
await page.evaluate(() => {
  const { view } = window.marpora;
  let pos = 0;
  view.state.doc.descendants((n, p) => { if (n.type.name === "code_block") pos = p + 2; });
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos))));
});
await page.locator(".md-fences.md-focus .ty-cm-lang-input").fill("typescript");
check("language box keeps editor selection out", await page.evaluate(() => document.activeElement?.classList.contains("ty-cm-lang-input")));
md = await text();
check("language box sets info", md.includes("```typescript\nlet x = 1;"), JSON.stringify(md));

// Source mode: raw Markdown in CodeMirror, edits flow back to the editor.
await page.evaluate(() => window.marpora.handleMenu("source-mode"));
await page.waitForSelector("#typora-source .CodeMirror", { state: "visible", timeout: 5000 }).catch(() => null);
const sourceText = await page.locator("#typora-source .CodeMirror-code").innerText().catch(() => "");
check("source mode shows markdown", sourceText.includes("# Title") && !(await page.locator("#write").isVisible()), sourceText);
await page.evaluate(() => {
  const cm = document.querySelector("#typora-source .CodeMirror").CodeMirror;
  cm.replaceRange("\n## Added in source\n", { line: cm.lineCount(), ch: 0 });
});
await page.evaluate(() => window.marpora.handleMenu("source-mode"));
await page.waitForSelector("#write", { state: "visible" });
check("source edit reaches editor", (await page.locator("#write h2").allTextContents()).includes("Added in source"));
md = await text();
check("source edit reaches core", md.includes("## Added in source"), JSON.stringify(md));

// Math block: `$$` + Enter opens the TeX panel with a live preview.
const parentType = () => page.evaluate(() => window.marpora.view.state.selection.$head.parent.type.name);
await page.evaluate(() => {
  const { view } = window.marpora;
  view.focus();
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atEnd(view.state.doc)));
});
await page.keyboard.press("Enter");
await page.keyboard.type("$$");
await page.keyboard.press("Enter");
await page.keyboard.type("x^2");
const preview = page.locator(".md-math-block.md-rawblock-on-edit .md-mathjax-preview mjx-container > svg");
check("math preview renders", await preview.waitFor({ timeout: 10000 }).then(() => true, () => false));
md = await text();
check("math block syncs", md.endsWith("$$\nx^2\n$$\n") || md.endsWith("$$\nx^2\n$$"), JSON.stringify(md));
await page.keyboard.press("Meta+Enter");
const formula = page.locator(".md-math-block:not(.md-rawblock-on-edit) > .md-math-container mjx-container");
check("math renders after leaving", await formula.isVisible());
await page.keyboard.press("ArrowUp");
check("arrow up enters math", (await parentType()) === "math_block");
await page.evaluate(() => {
  const { view } = window.marpora;
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atStart(view.state.doc)));
});
await page.locator(".md-math-block .md-math-container").last().click();
check("click on formula edits it", (await parentType()) === "math_block" && (await page.locator(".md-rawblock-on-edit").count()) === 1);

// Diagrams: a ```mermaid fence draws its chart and keeps it in step with the code.
await page.evaluate(() => {
  const { view } = window.marpora;
  view.focus();
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atEnd(view.state.doc)));
});
await page.keyboard.press("Meta+Enter");
await page.keyboard.type("```mermaid");
await page.keyboard.press("Enter");
await page.keyboard.type("graph LR");
await page.keyboard.press("Enter");
await page.keyboard.type("A --> B");
const nodes = page.locator("pre.md-diagram[lang=mermaid] .md-diagram-panel .node");
check("mermaid draws", await nodes.nth(1).waitFor({ timeout: 15000 }).then(() => true, () => false));
await page.keyboard.type(" --> C");
check("mermaid redraws on edit", await nodes.nth(2).waitFor({ timeout: 5000 }).then(() => true, () => false));
check("focused diagram shows code", await page.locator("pre.md-diagram.md-focus .CodeMirror").isVisible());
await page.keyboard.press("Meta+Enter");
check("unfocused diagram hides code", !(await page.locator("pre.md-diagram .CodeMirror").isVisible()));
await page.keyboard.press("ArrowUp");
check("arrow up enters diagram", (await parentType()) === "code_block");

// Sequence and flow charts draw too.
await page.evaluate(async () => {
  const m = window.marpora;
  const { text } = await m.backend.documentText(1);
  await m.backend.setText(1, `${text}\n\`\`\`sequence\nA->B: hi\n\`\`\`\n\n\`\`\`flow\nst=>start: Go\ne=>end\nst->e\n\`\`\`\n`);
  await m.sync.resync();
});
for (const lang of ["sequence", "flow"]) {
  const svg = page.locator(`pre.md-diagram[lang=${lang}] .md-diagram-panel-preview svg`);
  await svg.scrollIntoViewIfNeeded().catch(() => {});
  check(`${lang} draws`, await svg.waitFor({ timeout: 10000 }).then(() => true, () => false));
  check(`${lang} has no error`, (await page.locator(`pre[lang=${lang}] .md-diagram-panel-error`).textContent()) === "");
}

// Inline math, on a page with the flavor turned on: click the formula, edit its TeX.
const inline = await browser.newPage({ viewport: { width: 1000, height: 700 } });
inline.on("pageerror", (e) => errors.push(e.message));
await inline.addInitScript(() => localStorage.setItem("marpora.settings", JSON.stringify({ flavor: { inlineMath: true } })));
await inline.goto(process.env.URL ?? "http://localhost:1420/");
await inline.waitForSelector("#write");
await inline.evaluate(async () => {
  await window.marpora.backend.setText(1, "Euler: $e^{i\\pi}+1=0$ done.\n");
  await window.marpora.sync.resync();
});
const inlineFormula = inline.locator(".md-inline-math-container > mjx-container");
check("inline math renders", await inlineFormula.waitFor({ timeout: 10000 }).then(() => true, () => false));
await inlineFormula.click();
await inline.keyboard.type("+x");
await inline.keyboard.press("ArrowRight");
await inline.keyboard.type(" and");
md = await inline.evaluate(async () => {
  await window.marpora.sync.flush();
  return (await window.marpora.backend.documentText(1)).text;
});
check("inline math edits", md === "Euler: $e^{i\\pi}+1=0+x$ and done.\n", JSON.stringify(md));

// A flow chart on a page where nothing else has loaded Raphaël.
await inline.evaluate(async () => {
  await window.marpora.backend.setText(1, "```flow\nst=>start: Go\ne=>end\nst->e\n```\n");
  await window.marpora.sync.resync();
});
const flowSvg = inline.locator("pre[lang=flow] .md-diagram-panel-preview svg");
check("flow draws on its own", await flowSvg.waitFor({ timeout: 10000 }).then(() => true, () => false));
await inline.waitForTimeout(300);
check("flow on its own has no error", (await inline.locator("pre[lang=flow] .md-diagram-panel-error").textContent()) === "");

// HTML export: the rendered document without the editing machinery, math and diagrams
// as SVG (including a diagram far below the screen), footnotes at the end.
const exported = await inline.evaluate(async () => {
  const m = window.marpora;
  const filler = Array.from({ length: 80 }, (_, i) => `Filler ${i}.`).join("\n\n");
  await m.backend.setText(
    1,
    `# Title\n\nSoft\nbreak, note[^1] and $x^2$.\n\n$$\na+b\n$$\n\n${filler}\n\n\`\`\`mermaid\ngraph LR\nA-->B\n\`\`\`\n\n[^1]: The note.\n`,
  );
  await m.sync.resync();
  const run = async (id) => {
    m.backend.exports.clear();
    m.handleMenu(id);
    for (let i = 0; i < 200 && !m.backend.exports.size; i++) await new Promise((r) => setTimeout(r, 50));
    return [...m.backend.exports.values()][0] ?? "";
  };
  const styled = await run("export-html");
  const plain = await run("export-html-plain");
  const doc = new DOMParser().parseFromString(styled, "text/html");
  const q = (s) => doc.querySelector(s);
  return {
    body: doc.body.className === "typora-export" && !!q(".typora-export-content > #write"),
    styles: doc.querySelectorAll("style").length > 3,
    clean: !q("[contenteditable], .ProseMirror-widget, .md-meta, .code-tooltip"),
    heading: q("#write > h1")?.id === "title",
    softBreak: !!q("#write > p")?.textContent.startsWith("Soft\nbreak"),
    math: !!q(".md-math-block mjx-container svg") && !!q(".md-inline-math mjx-container svg"),
    diagram: !!q("pre[lang=mermaid] .md-diagram-panel-preview svg"),
    footnotes: q("#write > :last-child")?.className === "footnotes-area" && !!q(".footnote-line")?.textContent.includes("The note."),
    plain: !plain.includes("<style type='text/css'") && plain.includes("<h1"),
  };
});
check("export body", exported.body);
check("export has styles", exported.styles);
check("export has no editing parts", exported.clean);
check("export heading id", exported.heading);
check("export soft break is a newline", exported.softBreak);
check("export math as SVG", exported.math);
check("export offscreen diagram drawn", exported.diagram);
check("export footnotes at the end", exported.footnotes);
check("plain export has no styles", exported.plain);

check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(failures ? 1 : 0);
