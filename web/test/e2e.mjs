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
  await run("export-image");
  const image = [...m.backend.exports.keys()][0] === "/export/untitled.png" && [...m.backend.exports.values()][0] === styled;
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
    image,
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
check("image export takes the styled page", exported.image);

// Preferences › Export: another theme, page breaks and extra HTML in exports.
const exportPrefs = await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.updateSettings({
    exportTheme: "marpora-night",
    exportPageBreak: true,
    exportAppendHead: "<meta name='extra-head'>",
    exportAppendBody: "<p id='extra-tail'>tail</p>",
  });
  const run = async (id) => {
    m.backend.exports.clear();
    m.handleMenu(id);
    for (let i = 0; i < 200 && !m.backend.exports.size; i++) await new Promise((r) => setTimeout(r, 50));
    return new DOMParser().parseFromString([...m.backend.exports.values()][0] ?? "", "text/html");
  };
  const html = await run("export-html");
  const pdf = await run("export-pdf");
  const plain = await run("export-html-plain");
  await m.backend.updateSettings({ exportTheme: "", exportPageBreak: false, exportAppendHead: "", exportAppendBody: "" });
  const styleIds = (d) => [...d.querySelectorAll("style")].map((s) => s.id);
  const css = (d, id) => d.getElementById(id)?.textContent ?? "";
  return {
    theme: css(html, "style-theme").includes("--bg-color") && !styleIds(html).includes("style-marpora"),
    extra: !!html.querySelector("head meta[name='extra-head']") && html.body.lastElementChild?.id === "extra-tail",
    pageBreak: css(pdf, "style-page-break").includes("break-before: page") && !css(html, "style-page-break"),
    plain: !plain.querySelector("#extra-tail"),
  };
});
check("export uses the export theme", exportPrefs.theme);
check("export appends extra html", exportPrefs.extra);
check("pdf breaks pages at top headings", exportPrefs.pageBreak);
check("plain html has no extras", exportPrefs.plain);

// Find and replace: Typora's panel, counts, options, replace, Replace All and its Undo.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "Cat cat CAT.\n\nconcat and cat.\n");
  await m.sync.resync();
  m.view.dispatch(m.view.state.tr.setSelection(m.view.state.selection.constructor.atStart(m.view.state.doc)));
});
await inline.keyboard.press("Meta+f");
await inline.locator("#search-panel-input").fill("cat");
const searchStatus = () => inline.locator("#search-panel-status").textContent();
check("find counts matches", (await searchStatus()) === "1 / 5", await searchStatus());
check("find marks hits", (await inline.locator("#write .md-search-hit").count()) === 5);
await inline.keyboard.press("Enter");
check("enter goes to the next match", (await searchStatus()) === "2 / 5", await searchStatus());
await inline.keyboard.press("Shift+Enter");
await inline.keyboard.press("Shift+Enter");
check("shift-enter wraps to the last", (await searchStatus()) === "5 / 5", await searchStatus());
await inline.locator("#searchpanel-case-option-btn").dispatchEvent("mousedown");
check("case sensitive", (await searchStatus()) === "1 / 3", await searchStatus());
await inline.locator("#searchpanel-word-option-btn").dispatchEvent("mousedown");
check("whole word", (await searchStatus()) === "1 / 2", await searchStatus());
await inline.locator("#search-panel-input").fill("zzz");
check("no results", (await searchStatus()) === "No Results");
await inline.locator("#searchpanel-case-option-btn").dispatchEvent("mousedown");
await inline.locator("#searchpanel-word-option-btn").dispatchEvent("mousedown");
await inline.locator("#searchpanel-regexp-option-btn").dispatchEvent("mousedown");
await inline.locator("#search-panel-input").fill("c(a)t");
check("regexp", (await searchStatus()) === "1 / 5", await searchStatus());
await inline.locator("#searchpanel-regexp-option-btn").dispatchEvent("mousedown");
await inline.keyboard.press("Meta+Alt+f");
await inline.locator("#search-panel-input").fill("cat");
await inline.locator("#search-panel-replace-input").fill("dog");
await inline.locator("#search-panel-replace-btn").click();
const docText = () => inline.evaluate(async () => {
  await window.marpora.sync.flush();
  return (await window.marpora.backend.documentText(1)).text;
});
check("replace one", (await docText()).startsWith("dog cat CAT."), await docText());
check("replace moves on", (await searchStatus()) === "1 / 4", await searchStatus());
await inline.locator("#search-panel-replaceall-btn").click();
check("replace all", (await docText()) === "dog dog dog.\n\ncondog and dog.\n", await docText());
check("replace all message", (await inline.locator("#searchpanel-msg-content").textContent()) === "Replaced 4 occurrence(s)");
await inline.locator("#searchpanel-msg-undo-btn").click();
check("undo replace all", (await docText()) === "dog cat CAT.\n\nconcat and cat.\n", await docText());
await inline.keyboard.press("Escape");
check("escape closes and clears", !(await inline.locator("#md-searchpanel").isVisible()) &&
  (await inline.locator("#write .md-search-hit").count()) === 0);

// View › Status Bar: hidden, the page takes its room.
const pageBottom = () => inline.evaluate(() => document.querySelector("content").getBoundingClientRect().bottom);
/** Until content's transition ends at `bottom` (slow machines take longer than it lasts). */
const settled = (bottom) =>
  inline
    .waitForFunction((b) => document.querySelector("content").getBoundingClientRect().bottom === b, bottom, { timeout: 5000 })
    .catch(() => {});
await inline.evaluate(() => window.marpora.backend.updateSettings({ showStatusBar: false }));
await settled(700);
check("status bar hides", !(await inline.locator("footer.ty-footer").isVisible()) && (await pageBottom()) === 700, String(await pageBottom()));
await inline.evaluate(() => window.marpora.backend.updateSettings({ showStatusBar: true }));
await settled(670);
check("status bar shows", (await inline.locator("footer.ty-footer").isVisible()) && (await pageBottom()) === 670, String(await pageBottom()));

// The same panel searches the Markdown source in source mode.
await inline.evaluate(() => window.marpora.handleMenu("source-mode"));
await inline.waitForSelector("#typora-source .CodeMirror");
await inline.keyboard.press("Meta+f");
await inline.locator("#search-panel-input").fill("dog");
const sourceHits = await inline.locator("#typora-source .cm-search-hit").allTextContents();
check("source mode find", (await searchStatus()) === "1 / 1" && sourceHits.join("") === "dog", sourceHits.join("|"));
await inline.keyboard.press("Escape");
await inline.evaluate(() => window.marpora.handleMenu("source-mode"));

// Copy and paste: Markdown as the plain text, Markdown read back, pasted images stored.
const clip = await inline.evaluate(async () => {
  const m = window.marpora;
  const { view } = m;
  await m.backend.setText(1, "# Head\n\nSome **bold** and $x^2$ text.\n\n- one\n- two\n");
  await m.sync.resync();
  const Sel = view.state.selection.constructor;
  const at = (text) => {
    let pos = -1;
    view.state.doc.descendants((n, p) => { if (pos < 0 && n.isText && n.text.includes(text)) pos = p + n.text.indexOf(text); });
    return pos;
  };
  const copy = (from, to) => {
    view.dispatch(view.state.tr.setSelection(Sel.between(view.state.doc.resolve(from), view.state.doc.resolve(to))));
    const dt = new DataTransfer();
    view.dom.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return { text: dt.getData("text/plain"), html: dt.getData("text/html") };
  };
  const paste = (fill) => {
    const dt = new DataTransfer();
    fill(dt);
    view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  };
  const inline = copy(at("Some"), at(" text.") + 6).text;
  const list = copy(at("one"), at("two") + 3).text;
  const both = copy(at("bold"), at("two") + 3);
  let codeText = "";
  { const save = view.state.doc;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, m.view.state.schema.nodes.code_block.create({ info: "js" }, m.view.state.schema.text("let a = 1;"))));
    codeText = copy(at("a = 1"), at("a = 1") + 5).text;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, save.content)); }
  // Paste the copied HTML at the end: it comes back from its Markdown, math included.
  view.dispatch(view.state.tr.setSelection(Sel.atEnd(view.state.doc)));
  paste((dt) => { dt.setData("text/html", both.html); dt.setData("text/plain", both.text); });
  await m.sync.flush();
  const afterHtml = (await m.backend.documentText(1)).text;
  await m.backend.setText(1, "Start end\n");
  await m.sync.resync();
  view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(at(" end")))));
  paste((dt) => dt.setData("text/plain", " *mid* `c`"));
  view.dispatch(view.state.tr.setSelection(Sel.atEnd(view.state.doc)));
  paste((dt) => dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })));
  await new Promise((r) => setTimeout(r, 100));
  await m.sync.flush();
  return { inline, list, codeText, afterHtml, pasted: (await m.backend.documentText(1)).text, images: [...m.backend.images.keys()].join() };
});
check("copy gives markdown", clip.inline === "Some **bold** and $x^2$ text.", JSON.stringify(clip.inline));
check("copy in code is the code", clip.codeText === "a = 1", JSON.stringify(clip.codeText));
check("copy keeps list items in their list", clip.list === "- one\n- two", JSON.stringify(clip.list));
check("paste from the editor keeps math", clip.afterHtml.includes("**bold** and $x^2$ text.") && clip.afterHtml.trimEnd().endsWith("- two"),
  JSON.stringify(clip.afterHtml));
check("plain text pastes as markdown inline", clip.pasted.startsWith("Start *mid* `c` end"), JSON.stringify(clip.pasted));
check("pasted image is stored and shown", clip.images === "/images/image-1.png" && clip.pasted.includes("![image-1](/images/image-1.png)"),
  JSON.stringify(clip));

// Raw HTML: blocks render sanitized, inline tag pairs render their element.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, '<div class="box"><b>Bold</b> <a href="https://x.test">link</a><script>alert(1)</script></div>\n\n' +
    "<!-- note -->\n\nA <mark>marked</mark> and <kbd>K</kbd> line<br>next <span onclick=\"x()\">s</span>.\n");
  await m.sync.resync();
  m.view.dispatch(m.view.state.tr.setSelection(m.view.state.selection.constructor.atEnd(m.view.state.doc)));
});
const html = inline.locator("#write .md-htmlblock").first();
check("html block renders", await html.locator(".md-htmlblock-container > div.box > b").textContent() === "Bold" &&
  !(await html.locator(".md-htmlblock-panel").isVisible()));
check("html block sanitized", (await html.locator("script").count()) === 0);
const comment = await inline.locator("#write .md-htmlblock .md-raw-html-src-content").allTextContents();
check("html comment shows source", comment.join() === "<!-- note -->", JSON.stringify(comment));
check("inline html pairs render", (await inline.locator("#write p mark").textContent()) === "marked" &&
  (await inline.locator("#write p kbd").textContent()) === "K");
check("inline html tags hidden", (await inline.locator("#write p .md-html-tag:visible").count()) === 0);
check("inline br shows its source", (await inline.locator("#write p .md-br[md-inline=br] > .md-br-content").textContent()) === "<br>");
check("inline handlers dropped", (await inline.locator("#write p span[onclick]").count()) === 0 &&
  (await inline.locator("#write p span:not([class])").textContent()) === "s");
await inline.locator("#write p mark").click();
check("inline html tags shown at cursor", (await inline.locator("#write p .md-html-tag:visible").allTextContents()).join() === "<mark>,</mark>");
await html.locator(".md-htmlblock-container b").click();
check("click on html edits it", (await html.locator(".md-htmlblock-panel").isVisible()) &&
  (await inline.evaluate(() => window.marpora.view.state.selection.$head.parent.type.name)) === "html_block");
await inline.keyboard.type(" ");
check("html edit keeps source", (await docText()).startsWith('<div class="box"><b>Bold</b> <a href="https://x.test">link</a><script>alert(1)</script></div> \n'),
  await docText());

// Tables: Paragraph › Table's commands and the toolbar over the table with the cursor.
const tableAt = (text) => inline.evaluate(async (text) => {
  const { view } = window.marpora;
  let pos = -1;
  view.state.doc.descendants((n, p) => { if (pos < 0 && n.isText && n.text === text) pos = p; });
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos))));
  view.focus();
}, text);
const tableRun = async (...ids) => {
  for (const id of ids) await inline.evaluate((id) => window.marpora.handleMenu(id), id);
  await inline.evaluate(() => window.marpora.sync.flush());
  return (await docText()).trim();
};
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n");
  await m.sync.resync();
});
check("table toolbar hidden without the cursor", (await inline.locator(".ty-table-edit").count()) === 0);
await tableAt("1");
const bar = inline.locator("figure.md-table-fig > .ty-table-edit");
check("table toolbar over the cursor's table", (await bar.count()) === 1 &&
  (await bar.locator("button").evaluateAll((bs) => bs.map((b) => b.className.split(" ").pop()).join())) ===
    "md-resize-table,md-align-left,md-align-center,md-align-right,md-delete-table");
await bar.locator(".md-align-center").click();
check("toolbar aligns the column", (await tableRun()).includes("| :-: |") || /\| :-+: \| -+ \|/.test(await docText()), await docText());
check("align button shows the column's alignment", await bar.locator(".md-align-center").evaluate((b) => b.classList.contains("active")));
let tmd = await tableRun("table-row-down");
check("move table row down", /\| 3 +\| 4 +\|\n\| 1 +\| 2 +\|/.test(tmd), tmd);
tmd = await tableRun("table-row-below", "table-col-after");
check("add row and column", tmd.split("\n").filter((l) => l.startsWith("|")).length === 5 && /^\| a +\| +\| b +\|/.test(tmd), tmd);
tmd = await tableRun("table-col-left", "table-delete-col", "table-delete-row");
check("delete row and column", /^\| a +\| b +\|\n\| :-+: \| -+ \|\n\| 3 +\| 4 +\|\n\| 1 +\| 2 +\|\n\nafter$/.test(tmd), tmd);
await tableAt("2");
await bar.locator(".md-resize-table").click();
check("resize popover shows the size", (await inline.locator(".md-table-resize-popover .md-grid-ext").count()) === 6 &&
  (await inline.locator("#md-grid-width").inputValue()) === "2" && (await inline.locator("#md-grid-height").inputValue()) === "3");
await inline.locator(".md-grid-board tr[row='2'] td[col='3'] a").click();
tmd = await tableRun();
check("resize from the grid", /^\| a +\| b +\| +\|\n\| :-+: \| -+ \| -+ \|\n\| 3 +\| 4 +\| +\|\n\nafter$/.test(tmd), tmd);
await bar.locator(".md-delete-table").click();
tmd = await tableRun();
check("toolbar deletes the table", tmd === "after", JSON.stringify(tmd));
check("toolbar gone with the table", (await inline.locator(".ty-table-edit").count()) === 0);

// Paragraph › Table › Insert Table asks for the size in Typora's dialog.
const tableDialog = inline.locator("#table-insert-dialog");
await tableAt("after");
await inline.evaluate(() => window.marpora.handleMenu("table"));
await inline.waitForTimeout(50);
check("insert table dialog", (await tableDialog.locator(".modal-title").textContent()) === "Insert Table" &&
  (await inline.locator("#table-insert-col").inputValue()) === "3" && (await inline.locator("#table-insert-row").inputValue()) === "4" &&
  (await inline.evaluate(() => document.activeElement?.id)) === "table-insert-col");
await inline.keyboard.press("Escape");
check("escape closes the dialog", (await tableDialog.count()) === 0);
await inline.evaluate(() => window.marpora.handleMenu("table"));
await inline.waitForTimeout(50);
await inline.keyboard.type("2x");
await inline.keyboard.press("ArrowUp");
await inline.keyboard.press("Tab");
await inline.keyboard.type("2");
await inline.keyboard.press("Enter");
tmd = await tableRun();
check("dialog inserts the table", tableDialog && (await tableDialog.count()) === 0 &&
  /^after\n\n\| +\| +\| +\|\n\| -+ \| -+ \| -+ \|\n\| +\| +\| +\|$/.test(tmd), JSON.stringify(tmd));

// Right clicks tell the backend what they are on, for the native context menu.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "## Title\n\n> a **[site](https://x.test)** b\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet x;\n```\n");
  await m.sync.resync();
});
const contextOf = async (locator) => {
  await locator.click({ button: "right" });
  return inline.evaluate(() => JSON.stringify(window.marpora.backend.contextMenu));
};
let cx = await contextOf(inline.locator("#write h2"));
check("context menu on a heading", cx === JSON.stringify({ editor: true, link: false, image: false, table: false, block: null, active: ["heading-2"] }), cx);
cx = await contextOf(inline.locator("#write a").first());
check("context menu on a link", /"link":true/.test(cx) &&
  JSON.parse(cx).active.sort().join() === "link,paragraph,quote,strong", cx);
cx = await contextOf(inline.locator("#write td").first());
check("context menu in a table", /"table":true/.test(cx), cx);
cx = await contextOf(inline.locator("#write pre.md-fences").first());
check("context menu in a code block", /"block":"code"/.test(cx), cx);
await inline.mouse.click(3, 3, { button: "right" });
cx = await inline.evaluate(() => JSON.stringify(window.marpora.backend.contextMenu));
check("context menu outside the editor", cx === JSON.stringify({ editor: false }), cx);

// The status bar's word count popover, and what the status bar counts.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "One two three four.\n\nFive six.\n");
  await m.sync.resync();
});
await inline.waitForTimeout(250);
const wcLabel = () => inline.locator("#footer-word-count-label").textContent();
check("word count label", (await wcLabel()) === "6 Words", await wcLabel());
await inline.locator("#footer-word-count").click();
const wcRows = await inline.locator("#footer-word-count-info tr").evaluateAll((rows) => rows.map((r) => r.textContent).join("|"));
check("word count popover rows", wcRows === "6Words|24Characters|2Lines|≤ 1Minutes", wcRows);
await inline.locator("#footer-word-count-info tr[data-delimiter='1']").click();
check("popover picks characters", (await wcLabel()) === "24 Characters" && (await inline.locator("#footer-word-count-info").count()) === 0, await wcLabel());
await inline.evaluate(() => {
  const { view } = window.marpora;
  const TextSelection = Object.getPrototypeOf(view.state.selection.constructor).near(view.state.doc.resolve(1)).constructor;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5, 14)));
});
await inline.waitForTimeout(250);
check("selection counted", (await wcLabel()) === "9 / 24 Characters", await wcLabel());
await inline.waitForTimeout(150);
const agentSel = await inline.evaluate(() => JSON.stringify(window.marpora.backend.selection));
check("selection reported for agents", agentSel === JSON.stringify({ text: "two three", startBlock: 0, endBlock: 0 }), agentSel);
await inline.evaluate(() => window.marpora.handleMenu("word-count-popover"));
check("menu toggles the popover", (await inline.locator("#footer-word-count-info .footer-word-count-info-line").textContent()).includes("2 Words"));
await inline.keyboard.press("Escape");
check("escape closes the popover", (await inline.locator("#footer-word-count-info").count()) === 0);
await inline.locator("#footer-word-count").click();
await inline.locator("#footer-word-count-info tr[data-delimiter='0']").click();

// View › Toggle Outline Popover lists the headings and goes to one.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "# One\n\ntext\n\n## Two\n\nmore\n");
  await m.sync.resync();
  m.handleMenu("outline-popover");
});
await inline.waitForTimeout(250);
const outlineRows = await inline.locator("#ty-outline-popover .outline-label").allTextContents();
check("outline popover lists headings", outlineRows.join() === "One,Two", outlineRows.join());
await inline.locator("#ty-outline-popover .outline-h2 .outline-item").click();
check("outline popover goes to the heading", (await inline.locator("#ty-outline-popover").count()) === 0 &&
  (await inline.evaluate(() => window.marpora.view.state.selection.$head.parent.textContent)) === "Two");

// Format › Image: zoom, syntax switching and moving the file of the image at the cursor.
const imageText = async (id) => inline.evaluate(async (id) => {
  const m = window.marpora;
  if (id) m.handleMenu(id);
  await new Promise((r) => setTimeout(r, 50));
  await m.sync.flush();
  return (await m.backend.documentText(1)).text;
}, id);
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "Pic ![cat](a.png) end\n");
  await m.sync.resync();
  const { view } = m;
  const TextSelection = Object.getPrototypeOf(view.state.selection.constructor).near(view.state.doc.resolve(1)).constructor;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
});
const imgCx = await contextOf(inline.locator("#write .md-image").first());
check("context menu on an image", /"image":true/.test(imgCx) &&
  (await inline.evaluate(() => window.marpora.view.state.selection.node?.type.name)) === "image", imgCx);
let imgText = await imageText("image-zoom:100");
check("100% leaves a markdown image", imgText === "Pic ![cat](a.png) end\n", imgText);
imgText = await imageText("image-zoom:50");
check("zoom writes an img tag", imgText === 'Pic <img src="a.png" alt="cat" style="zoom:50%;" /> end\n', imgText);
imgText = await imageText("image-zoom:200");
check("zoom again replaces it", imgText === 'Pic <img src="a.png" alt="cat" style="zoom:200%;" /> end\n', imgText);
imgText = await imageText("image-syntax-markdown");
check("switch to markdown syntax", imgText === "Pic ![cat](a.png) end\n", imgText);
imgText = await imageText("image-syntax-html");
check("switch to html syntax", imgText === 'Pic <img src="a.png" alt="cat" /> end\n', imgText);
await inline.evaluate(() => (window.marpora.backend.relocateTo = "img/b.png"));
imgText = await imageText("image-move-to");
check("move image updates its src", imgText === 'Pic <img src="img/b.png" alt="cat" /> end\n', imgText);
await inline.evaluate(() => window.marpora.handleMenu("image-copy"));
const imgLog = await inline.evaluate(() => window.marpora.backend.imageLog.join());
check("image file actions reach the backend", imgLog === "move a.png,copy img/b.png", imgLog);

// Format › Image › Use Image Root Path, When Insert and Move All Images write the
// front matter Typora reads, and `/` paths load under the root.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "![a](/img/a.png) ![b](b.png) ![w](https://x.test/w.png)\n");
  await m.sync.resync();
  m.backend.pickedFolder = "/site";
  m.handleMenu("image-root");
});
await inline.waitForTimeout(200);
imgText = await imageText();
check("root path goes in the front matter", imgText.startsWith("---\ntypora-root-url: /site\n---\n"), imgText);
const imgSrcs = await inline.locator("#write .md-image img").evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src")).join());
check("images load under the root", imgSrcs === "/site/img/a.png,b.png,https://x.test/w.png", imgSrcs);
imgText = await imageText("image-insert:assets");
check("when insert rule in the front matter", imgText.startsWith("---\ntypora-root-url: /site\ntypora-copy-images-to: ./assets\n---\n"), imgText);
imgText = await imageText("image-insert:global");
check("follow global settings drops the rule", imgText.startsWith("---\ntypora-root-url: /site\n---\n"), imgText);
await inline.evaluate(() => (window.marpora.backend.pickedFolder = "/pics"));
imgText = await imageText("images-move-all");
check("move all images repoints them", imgText.endsWith("![a](/pics/a.png) ![b](/pics/b.png) ![w](https://x.test/w.png)\n"), imgText);
const moveLog = await inline.evaluate(() => window.marpora.backend.imageLog.at(-1));
check("move all images sends rooted local files", moveLog === "move /site/img/a.png b.png to /pics", moveLog);

// Edit › Line Endings converts the text; Whitespace and Line Breaks restyles it.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "one\ntwo <br/> three\n\npara\n");
  await m.sync.resync();
});
const rawText = () => inline.evaluate(async () => (await window.marpora.backend.documentText(1)).text);
await inline.evaluate(() => window.marpora.handleMenu("line-endings-crlf"));
await inline.waitForTimeout(100);
check("windows line endings", (await rawText()) === "one\r\ntwo <br/> three\r\n\r\npara\r\n", JSON.stringify(await rawText()));
await inline.evaluate(() => window.marpora.handleMenu("line-endings-lf"));
await inline.waitForTimeout(100);
check("unix line endings", (await rawText()) === "one\ntwo <br/> three\n\npara\n", JSON.stringify(await rawText()));
const brSource = inline.locator("#write .md-br-content");
check("br source visible by default", (await brSource.evaluate((e) => getComputedStyle(e).opacity)) !== "0");
await inline.evaluate(() => window.marpora.backend.updateSettings({ hideBr: true, ignoreLineBreak: true, indentFirstLine: true }));
await inline.waitForTimeout(100);
check("visible br off hides its source", (await brSource.evaluate((e) => getComputedStyle(e).opacity)) === "0");
check("preserve single line break shows a space", (await inline.locator("#write br.md-soft-break").first().isVisible()) === false &&
  (await inline.locator("#write .md-softbreak-space").count()) === 1);
check("indent first line", await inline.evaluate(() => {
  const p = document.querySelector("#write").lastElementChild;
  return document.querySelector("#write").classList.contains("first-line-indent") && getComputedStyle(p).textIndent !== "0px";
}));
const brExport = await inline.evaluate(async () => {
  const m = window.marpora;
  m.backend.exports.clear();
  m.handleMenu("export-html-plain");
  for (let i = 0; i < 200 && !m.backend.exports.size; i++) await new Promise((r) => setTimeout(r, 50));
  return [...m.backend.exports.values()][0] ?? "";
});
check("br exports as html with soft breaks as newlines", /two <br\/?> three/.test(brExport) && /one\ntwo/.test(brExport) && !brExport.includes("md-softbreak-space"),
  brExport.slice(brExport.indexOf("<p"), brExport.indexOf("<p") + 200));
await inline.evaluate(() => window.marpora.backend.updateSettings({ hideBr: false, ignoreLineBreak: false, indentFirstLine: false }));
await inline.waitForTimeout(100);
check("whitespace options off again", (await inline.locator("#write .md-softbreak-space").count()) === 0 &&
  !(await inline.evaluate(() => document.querySelector("#write").classList.contains("first-line-indent"))));

// Format menu: underline, inline math and comments; links open with ⌘-click.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "Hello world and more\n\n# My Heading\n\n[jump](#my-heading) and [site](https://x.test)\n");
  await m.sync.resync();
});
const selectText = (text) => inline.evaluate((text) => {
  const { view } = window.marpora;
  let pos = -1;
  view.state.doc.descendants((n, p) => { if (pos < 0 && n.isText && n.text.includes(text)) pos = p + n.text.indexOf(text); });
  const Selection = Object.getPrototypeOf(view.state.selection.constructor);
  const TextSelection = Selection.near(view.state.doc.resolve(pos)).constructor;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, pos + text.length)));
}, text);
await selectText("world");
let fmd = await tableRun("underline");
check("underline wraps in <u>", fmd.startsWith("Hello <u>world</u> and"), fmd);
check("underline renders", (await inline.locator("#write p u").textContent()) === "world");
fmd = await tableRun("underline");
check("underline again removes it", fmd.startsWith("Hello world and"), fmd);
await selectText("and");
fmd = await tableRun("inline-math");
check("inline math from the selection", fmd.startsWith("Hello world $and$ more"), fmd);
await selectText("Hello");
fmd = await tableRun("comment");
check("comment wraps the selection", fmd.startsWith("<!-- Hello --> world"), fmd);
await inline.locator("#write a", { hasText: "site" }).click({ modifiers: ["Meta"] });
check("⌘-click opens a link", (await inline.evaluate(() => window.marpora.backend.links.join())) === "https://x.test");
await inline.locator("#write a", { hasText: "jump" }).click({ modifiers: ["Meta"] });
await inline.waitForTimeout(50);
check("⌘-click on #anchor goes to the heading",
  (await inline.evaluate(() => window.marpora.view.state.selection.$head.parent.textContent)) === "My Heading");

// Edit menu: selection, moving rows, transformations, copy as and paste as plain text.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "First **bold** word here\n\n- one\n- two\n\nLast line\n");
  await m.sync.resync();
});
const caretIn = (text, offset = 1) => inline.evaluate(([text, offset]) => {
  const { view } = window.marpora;
  let pos = -1;
  view.state.doc.descendants((n, p) => { if (pos < 0 && n.isText && n.text.includes(text)) pos = p + n.text.indexOf(text) + offset; });
  const Selection = Object.getPrototypeOf(view.state.selection.constructor);
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))));
}, [text, offset]);
const selected = () => inline.evaluate(() => {
  const { state } = window.marpora.view;
  return state.doc.textBetween(state.selection.from, state.selection.to);
});
await caretIn("word");
await tableRun("select-word");
check("select word", (await selected()) === "word", await selected());
await caretIn("bold");
await tableRun("select-scope");
check("select styled scope", (await selected()) === "bold", await selected());
await tableRun("copy-markdown");
check("copy as markdown", (await inline.evaluate(() => window.marpora.backend.clipboard.text)) === "**bold**");
await tableRun("select-line");
check("select line", (await selected()) === "First bold word here", await selected());
await caretIn("word");
await tableRun("select-word");
let emd = await tableRun("upper-case");
check("make upper case", emd.startsWith("First **bold** WORD here"), emd);
await tableRun("select-line");
emd = await tableRun("capitalize");
check("capitalize keeps marks", emd.startsWith("First **Bold** Word Here"), emd);
await caretIn("one");
emd = await tableRun("move-row-down");
check("move list item down", emd.includes("- two\n- one"), emd);
await caretIn("Last");
emd = await tableRun("move-row-up");
check("move block up", /Here\n\nLast line\n\n- two\n- one$/.test(emd), emd);
await caretIn("Last");
emd = await tableRun("delete-word");
check("delete word", emd.includes("\n\n line\n\n"), emd);
await inline.evaluate(() => { window.marpora.backend.clipboard = { text: "*x* y" }; });
await caretIn("two", 3);
emd = await tableRun("paste-plain");
await inline.waitForTimeout(50);
emd = await tableRun();
check("paste as plain text", emd.includes("- two\\*x\\* y"), emd);
await caretIn("Word");
emd = await tableRun("delete-block");
check("delete paragraph", emd.startsWith("line\n\n- two") && !emd.includes("Word"), emd);

// Paragraph menu: task status, paragraphs around blocks, footnotes, references, front matter.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "- [ ] task\n\nText here\n");
  await m.sync.resync();
});
await caretIn("task");
let pmd = await tableRun("task-toggle");
check("toggle task status", pmd.startsWith("- [x] task"), pmd);
pmd = await tableRun("task-incomplete");
check("mark as incomplete", pmd.startsWith("- [ ] task"), pmd);
await caretIn("Text");
pmd = await tableRun("paragraph-before");
await inline.keyboard.type("Before");
pmd = await tableRun();
check("insert paragraph before", /task\n\nBefore\n\nText here$/.test(pmd), pmd);
await caretIn("Text", 4);
await tableRun("footnote");
await inline.keyboard.type("The note");
pmd = await tableRun();
check("footnote reference and definition", /Text\[\^1\] here\n\n\[\^1\]: The note$/.test(pmd), pmd);
await tableRun("front-matter");
await inline.keyboard.type("title: x");
pmd = await tableRun();
check("yaml front matter", pmd.startsWith("---\ntitle: x\n---\n"), pmd);
await caretIn("Before");
await tableRun("link-reference");
await inline.keyboard.type("ref");
pmd = await tableRun();
check("link reference", pmd.includes("Before\n\n[ref]: \n"), JSON.stringify(pmd));

// GitHub alerts: Typora's markup, the marker's source at the cursor, Paragraph › Alert.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "> [!NOTE]\n> Useful info\n\n> plain quote\n\nPara text\n");
  await m.sync.resync();
});
await caretIn("Para");
const note = inline.locator("#write div.md-alert.md-alert-note");
check("alert renders as typora's div", (await note.count()) === 1 && (await inline.locator("#write blockquote").count()) === 1);
check("alert label", (await note.locator(".md-alert-text-container").getAttribute("data-text")) === "note" &&
  !(await note.locator(".md-alert-src").isVisible()));
await caretIn("Useful", 6);
await inline.keyboard.type(" and more");
let amd = await tableRun();
check("editing an alert keeps its marker", amd.startsWith("> [!NOTE]\n> Useful and more info"), amd);
await caretIn("[!NOTE]", 3);
await inline.waitForTimeout(30);
check("marker source shown at the cursor", await note.locator(".md-alert-src").isVisible());
amd = await tableRun("alert-caution");
check("change the alert's type", amd.startsWith("> [!CAUTION]\n> Useful"), amd);
await caretIn("plain");
amd = await tableRun("alert-tip");
check("quote becomes an alert", amd.includes("> [!TIP]\n> plain quote"), amd);
await caretIn("Para", 4);
amd = await tableRun("alert-warning");
check("paragraph becomes an alert", amd.endsWith("> [!WARNING]\n> Para text"), amd);
check("alerts render after the change", (await inline.locator("#write div.md-alert").count()) === 3);

// Images: their Markdown shows to edit while selected; Format › Image › Insert Image.
await inline.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, "A ![pic](a.png) b\n");
  await m.sync.resync();
});
const imgSrc = inline.locator("#write .md-image > .md-image-src");
check("image markdown in its source", (await imgSrc.textContent()) === "![pic](a.png)");
await inline.evaluate(() => {
  const el = document.querySelector("#write .md-image > .md-image-src");
  el.textContent = '![new](<b c.png> "T")';
  el.dispatchEvent(new Event("input"));
});
let imd = await tableRun();
check("editing the source changes the image", imd === 'A ![new](<b c.png> "T") b', imd);
await caretIn("b", 1);
await tableRun("insert-image");
await inline.waitForTimeout(50);
await inline.keyboard.type("alt");
imd = await tableRun();
check("insert image types its alt", imd === 'A ![new](<b c.png> "T") b![alt]()', imd);
await inline.keyboard.press("Enter");
await inline.keyboard.type("!");
imd = await tableRun();
check("enter leaves the image source", imd.endsWith("![alt]()!"), imd);

// The sidebar (outline, article list, file tree) and Quick Open, on a fake folder.
const lib = await browser.newPage({ viewport: { width: 1000, height: 700 } });
lib.on("pageerror", (e) => errors.push(e.message));
await lib.goto(process.env.URL ?? "http://localhost:1420/");
await lib.waitForSelector("#write");
await lib.evaluate(async () => {
  const { backend, sync } = window.marpora;
  backend.library = {
    root: "/home/me/notes",
    files: {
      "/home/me/notes/todo.md": "# Todo\n\nBuy milk",
      "/home/me/notes/Welcome.md": "---\ntitle: Hello there\n---\nBody",
      "/home/me/notes/sub/deep.md": "Deep",
    },
    recent: ["/home/me/notes/Welcome.md", "/home/me/old/plan.md"],
    folders: ["/home/me/notes", "/home/me/other"],
  };
  await backend.setText(1, "# One\n\n## Two\n\n# Three\n");
  await sync.resync();
});
await lib.evaluate(() => window.marpora.handleMenu("outline"));
await lib.waitForSelector("#outline-content .outline-h2");
check("sidebar shows", await lib.locator("body.pin-outline #typora-sidebar.active-tab-outline").isVisible());
check("outline nests headings",
  (await lib.locator("#outline-content > .outline-h1").count()) === 2 &&
  (await lib.locator(".outline-h1 > .outline-children > .outline-h2 .outline-label").textContent()) === "Two");
await lib.click("#sidebar-search-btn");
check("outline filter box", await lib.locator("#typora-sidebar.ty-show-outline-filter #file-library-search-input[placeholder='Filter']").isVisible());
await lib.keyboard.type("tw");
const shownHeadings = () => lib.locator("#outline-content .outline-item:visible .outline-label").allTextContents();
check("outline filter hides other headings", (await shownHeadings()).join() === "Two" &&
  (await lib.locator(".ty-outline-hit").textContent()) === "Tw", (await shownHeadings()).join());
await lib.keyboard.press("ArrowDown");
await lib.keyboard.press("Enter");
check("filter enter goes to the heading", await lib.evaluate(() => window.marpora.view.state.selection.$head.parent.textContent === "Two"));
await lib.click("#file-library-search-input");
await lib.keyboard.press("Escape");
check("escape closes the filter", (await shownHeadings()).join() === "One,Two,Three" && await lib.locator(".sidebar-tabs").isVisible());
await lib.evaluate(() => window.marpora.handleMenu("articles"));
await lib.waitForSelector("#file-library-list[data-state=complete] .file-library-node");
check("articles tab", (await lib.locator("#sidepanel-segmented-input-files").textContent()) === "Articles" &&
  await lib.locator("#file-library-list").isVisible());
const listNames = await lib.locator("#file-library-list-children .file-list-item-file-name").allTextContents();
check("article list grouped by folder, sorted naturally", listNames.join() === "todo.md,Welcome.md,deep.md", listNames.join());
check("article summaries", (await lib.locator(".file-list-item[data-path$='Welcome.md'] .file-list-item-summary").innerHTML()) === "Hello there<br>Body" &&
  (await lib.locator(".file-list-item[data-path$='todo.md'] .file-list-item-summary").innerHTML()).includes("<br>Buy milk"));
check("folder names shown", (await lib.locator("#file-library-list-children.show-folder-name").count()) === 1 &&
  (await lib.locator(".file-list-item[data-path$='deep.md'] .file-list-item-parent-loc").textContent()) === "sub");
await lib.locator(".file-list-item[data-path$='todo.md']").click();
const opened = () => lib.evaluate(() => window.marpora.backend.opened.slice());
check("click opens the file", (await opened()).at(-1) === "/home/me/notes/todo.md");

await lib.evaluate(() => window.marpora.handleMenu("file-tree"));
await lib.waitForSelector("#file-library-tree .file-node-root .file-tree-node");
const treeNames = await lib.locator(".file-node-root > .file-node-children > .file-tree-node > .file-node-content .file-node-title").allTextContents();
check("file tree: folders first", treeNames.join() === "sub,todo.md,Welcome.md", treeNames.join());
await lib.locator(".file-tree-node[data-path$='/sub'] > .file-node-content").click();
await lib.waitForSelector(".file-tree-node[data-path$='/sub'].file-node-expanded .file-tree-node[data-path$='deep.md']");
check("folder expands", true);
await lib.locator(".file-tree-node[data-path$='deep.md'] > .file-node-content").click();
check("tree opens the file", (await opened()).at(-1) === "/home/me/notes/sub/deep.md");

// The footer's menu: actions, sorting and recent folders.
await lib.hover("#file-library-tree");
check("footer shows the folder", (await lib.locator("#sidebar-footer-main-item-label").textContent()).trim() === "notes" &&
  await lib.locator("#sidebar-new-file-btn").isVisible() && await lib.locator("#switch-file-list-btn .switch-file-list-btn-to-list").isVisible());
await lib.click("#sidebar-menu-btn .sidebar-footer-item");
const menuText = () => lib.locator("#sidebar-files-menu > li").evaluateAll((lis) => lis.map((li) => li.textContent.trim()));
check("footer menu", (await menuText()).join() === "Action,New File,Search,Reveal in Finder,Open Folder...,Refresh Folder,Sort,Recent Locations,other,notes",
  (await menuText()).join());
check("current folder marked", (await lib.locator(".selected-folder-menu-item").textContent()).trim() === "notes");
const treeOrder = () => lib.locator(".file-node-root > .file-node-children > .file-tree-node > .file-node-content .file-node-title").allTextContents();
await lib.click("#ty-sort-by-name-btn");
await lib.click("#ty-sort-by-name-btn");
check("sort by name, descending", (await treeOrder()).join() === "sub,Welcome.md,todo.md" &&
  (await lib.getAttribute("#ty-sort-by-name-btn", "aria-label")) === "Sort by Name (Descending)", (await treeOrder()).join());
await lib.click("#ty-group-by-folder-btn");
check("ungrouped mixes folders in", (await treeOrder()).join() === "Welcome.md,todo.md,sub", (await treeOrder()).join());
check("sort saved in settings", await lib.evaluate(async () => {
  const s = await window.marpora.backend.settings();
  return s.treeSort === -1 && s.treeNoGroup && s.listSort === 0;
}));
check("sort buttons keep the menu open", await lib.locator("#sidebar-files-menu").isVisible());
await lib.click("#new-file-from-sidebar-menu");
await lib.waitForTimeout(100);
check("new file opens", (await opened()).at(-1) === "/home/me/notes/Untitled.md" && !(await lib.locator("#sidebar-files-menu").isVisible()),
  `${(await opened()).at(-1)} ${await lib.locator("#sidebar-files-menu").isVisible()}`);
const renameInput = lib.locator("#file-library-tree .file-node-on-edit > .file-node-content > .file-tree-rename-div > input");
const renameReady = await renameInput.waitFor({ timeout: 3000 }).then(() => true, () => false);
const renameState = renameReady && await renameInput.evaluate((i) => [document.activeElement === i, i.value, i.selectionStart, i.selectionEnd].join());
check("new file starts a rename", renameState === "true,Untitled.md,0,8", String(renameState));
await lib.keyboard.type("Plan");
await lib.keyboard.press("Enter");
await lib.waitForTimeout(100);
check("rename renames", (await lib.evaluate(() => window.marpora.backend.libraryLog.at(-1))) === "rename /home/me/notes/Untitled.md /home/me/notes/Plan.md" &&
  (await renameInput.count()) === 0 && (await lib.locator("#file-library-tree .file-tree-node[data-path='/home/me/notes/Plan.md']").count()) === 1,
  await lib.evaluate(() => window.marpora.backend.libraryLog.join()));

// The context menu, with Typora's items for a file, a folder and the tree's empty space.
const menuItems = () => lib.locator("#file-menu > li").evaluateAll((lis) => lis.map((li) => li.textContent.trim() || "-").join("|"));
const lastLog = () => lib.evaluate(() => window.marpora.backend.libraryLog.at(-1));
const fileRow = (path) => lib.locator(`#file-library-tree .file-tree-node[data-path='${path}'] > .file-node-content`);
await fileRow("/home/me/notes/todo.md").click({ button: "right" });
check("file menu items", (await menuItems()) ===
  "Open|Open in New Window|-|New File|New Folder|-|Search|-|Articles (List View)|File Tree (Tree View)|-|Rename|Duplicate|-|Delete|-|Copy File Path|Open File Location",
  await menuItems());
await lib.locator("#file-menu [data-action='duplicate'] a").dispatchEvent("mousedown");
await lib.waitForTimeout(100);
check("duplicate", (await lastLog()) === "duplicate /home/me/notes/todo.md" && (await lib.locator("#file-menu").count()) === 0 &&
  (await fileRow("/home/me/notes/todo (copy).md").count()) === 1, await lastLog());
await fileRow("/home/me/notes/todo (copy).md").click({ button: "right" });
await lib.locator("#file-menu [data-action='delete'] a").dispatchEvent("mousedown");
await lib.waitForTimeout(100);
check("delete moves to the trash", (await lastLog()) === "trash /home/me/notes/todo (copy).md" &&
  (await fileRow("/home/me/notes/todo (copy).md").count()) === 0, await lastLog());
await fileRow("/home/me/notes/sub").click({ button: "right" });
check("folder menu items", (await menuItems()) ===
  "Open in New Window|-|New File|New Folder|-|Search|-|Articles (List View)|File Tree (Tree View)|-|Rename|-|Delete|-|Copy File Path|Open File Location",
  await menuItems());
await lib.locator("#file-menu [data-action='rename'] a").dispatchEvent("mousedown");
const folderRename = lib.locator("#file-library-tree .file-node-on-edit[data-path='/home/me/notes/sub'] input");
check("rename from the menu", await folderRename.waitFor({ timeout: 2000 }).then(() => true, () => false));
await lib.keyboard.press("Escape");
check("escape cancels the rename", (await folderRename.count()) === 0 && (await lastLog()) === "trash /home/me/notes/todo (copy).md",
  `${await folderRename.count()} ${await lastLog()} ${await lib.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`);
await lib.evaluate(() => {
  const tree = document.querySelector("#file-library-tree");
  tree.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 500 }));
});
check("empty space offers new files", (await menuItems()) === "New File|New Folder", await menuItems());
await lib.keyboard.press("Escape");
check("escape closes the menu", (await lib.locator("#file-menu").count()) === 0);

// The sidebar's Search (⇧⌘F): find in the folder's files.
await lib.evaluate(() => window.marpora.handleMenu("search"));
check("search box replaces the tabs", await lib.locator("#typora-sidebar.ty-show-search #file-library-search-input").isVisible() &&
  !(await lib.locator(".sidebar-tabs").isVisible()) &&
  (await lib.evaluate(() => document.activeElement.id)) === "file-library-search-input");
const searchFor = async (text) => {
  await lib.fill("#file-library-search-input", text);
  await lib.press("#file-library-search-input", "Enter");
  await lib.waitForSelector("#typora-sidebar.ty-on-search #file-library-search-result > *");
};
await searchFor("milk");
const milk = lib.locator(".ty-search-item[data-path='/home/me/notes/todo.md']");
check("search finds lines", (await lib.locator(".ty-search-item").count()) === 1 &&
  (await milk.locator(".file-list-item-count").textContent()) === "1" &&
  (await milk.locator(".ty-search-item-line").innerHTML()) === '<span>Buy </span><span class="ty-file-search-match-text">milk</span>' &&
  !(await lib.locator("#file-library").isVisible()));
await searchFor("welcome");
check("search finds file names", (await lib.locator(".ty-search-item .file-list-item-file-name").innerHTML()).includes('<span class="ty-file-search-match-text">Welcome</span>') &&
  (await lib.locator(".ty-search-item .file-list-item-count").textContent()) === "0" &&
  (await lib.locator(".ty-search-item .ty-search-item-line").textContent()) === "---");
await searchFor("zzz");
check("no results", (await lib.locator(".ty-search-result-error-message").textContent()) === "No result found.");
await lib.hover("#ty-sidebar-search-tabs");
await lib.click("#filesearch-regexp-option-btn");
await searchFor("(");
check("bad regexp reported", (await lib.locator(".ty-search-result-error-message").count()) === 1 &&
  (await lib.locator(".ty-search-result-error-message").textContent()) !== "No result found." &&
  (await lib.evaluate(async () => (await window.marpora.backend.settings()).fileSearchUseRegexp)));
await lib.click("#filesearch-regexp-option-btn");
await searchFor("milk");
await lib.click(".ty-search-item-line");
check("result line opens its file", (await opened()).at(-1) === "/home/me/notes/todo.md" &&
  (await lib.locator(".ty-search-item-line.active").count()) === 1);
await lib.press("#file-library-search-input", "Escape");
check("escape closes the search", !(await lib.locator("#typora-sidebar.ty-show-search").count()) && await lib.locator("#file-library").isVisible());

await lib.click("#write");
await lib.keyboard.press("Meta+Shift+o");
await lib.waitForSelector("#typora-quick-open .typora-quick-open-item");
check("quick open shows recent files first",
  (await lib.locator("#ty-quick-open-recent-list-inner .typora-quick-open-item-title").allTextContents()).join() === "Welcome.md,plan.md");
await lib.keyboard.type("deep");
const quick = await lib.locator("#typora-quick-open .typora-quick-open-item.active .typora-quick-open-item-title").innerHTML();
check("quick open filters and marks", quick === "<b>deep</b>.md", quick);
check("quick open path", (await lib.locator(".typora-quick-open-item.active .typora-quick-open-item-path").textContent()) === "notes/sub/");
await lib.keyboard.press("Enter");
check("enter opens and closes", (await opened()).at(-1) === "/home/me/notes/sub/deep.md" &&
  !(await lib.locator("#typora-quick-open").isVisible()));
await lib.keyboard.press("Meta+Shift+o");
await lib.keyboard.press("Escape");
check("escape closes quick open", !(await lib.locator("#typora-quick-open").isVisible()));
await lib.hover("#file-library-tree");
// Pin and remove buttons on recent folders, which leave the menu open.
await lib.evaluate(() => window.marpora.backend.library.folders.push("/home/me/old"));
await lib.click("#sidebar-menu-btn .sidebar-footer-item");
await lib.locator(".folder-menu-item[data-path='/home/me/old'] .sidebar-folder-pin").dispatchEvent("mousedown", { button: 0 });
await lib.waitForSelector(".folder-menu-item[data-path='/home/me/old'][data-pinned='true']");
const recentNames = () => lib.locator(".folder-menu-item").allTextContents().then((t) => t.map((s) => s.trim()).join());
check("pinned folder comes first", (await recentNames()) === "old,other,notes" &&
  (await lib.locator(".folder-menu-item[data-path='/home/me/old'] .sidebar-folder-pin").getAttribute("ty-hint")) === "Unpin", await recentNames());
await lib.locator(".folder-menu-item[data-path='/home/me/old'] .sidebar-folder-pin").dispatchEvent("mousedown", { button: 0 });
await lib.waitForSelector(".folder-menu-item[data-path='/home/me/old'][data-pinned='false']");
await lib.locator(".folder-menu-item[data-path='/home/me/old'] .sidebar-folder-remove").dispatchEvent("mousedown", { button: 0 });
await lib.waitForFunction(() => !document.querySelector(".folder-menu-item[data-path='/home/me/old']"));
check("removed folder leaves the list", (await recentNames()) === "other,notes" &&
  !(await lib.evaluate(() => window.marpora.backend.library.folders.includes("/home/me/old"))), await recentNames());
await lib.click(".folder-menu-item[data-path='/home/me/other'] a");
await lib.waitForFunction(() => document.querySelector("#sidebar-footer-main-item-label").textContent.trim() === "other");
check("recent location switches the folder", (await lib.evaluate(() => window.marpora.backend.libraryLog.at(-1))) === "switch /home/me/other");

await lib.reload();
await lib.waitForSelector("#write");
check("sidebar kept across reload", await lib.locator("body.pin-outline #typora-sidebar.use-file-tree-style.active-tab-files").isVisible());

// The file changes on disk: applied in place when there are no unsaved edits, else asked.
const disk = await browser.newPage({ viewport: { width: 1000, height: 700 } });
disk.on("pageerror", (e) => errors.push(e.message));
await disk.goto(process.env.URL ?? "http://localhost:1420/");
await disk.waitForSelector("#write");
const diskText = () => disk.evaluate(async () => {
  await window.marpora.sync.flush();
  return (await window.marpora.backend.documentText(1)).text;
});
await disk.evaluate(() => window.marpora.backend.changeOnDisk("# From disk\n\nOne\n"));
await disk.waitForSelector("#write h1:text('From disk')");
check("clean document reloads in place", (await diskText()) === "# From disk\n\nOne\n" &&
  !(await disk.evaluate(() => window.marpora.backend.isDirty(1))));
await disk.waitForSelector("#write .md-remote-edit", { timeout: 1000 });
check("outside changes light up", (await disk.locator("#write .md-remote-edit").count()) > 0);
await disk.waitForFunction(() => !document.querySelector("#write .md-remote-edit"), null, { timeout: 3000 });
check("and fade away", (await disk.locator("#write .md-remote-edit").count()) === 0);
let asked = null;
disk.on("dialog", (d) => { asked = d.message(); void (asked && globalThis.acceptDialog ? d.accept() : d.dismiss()); });
await disk.click("#write p");
await disk.keyboard.press("End");
await disk.keyboard.type(" mine");
await diskText();
globalThis.acceptDialog = false;
await disk.evaluate(() => window.marpora.backend.changeOnDisk("# From disk\n\nTwo\n"));
await disk.waitForTimeout(300);
check("unsaved edits: asks first", asked === "File content is changed by external applications. Reload content from disk ?", String(asked));
check("keeping edits", (await diskText()) === "# From disk\n\nOne mine\n", await diskText());
globalThis.acceptDialog = true;
await disk.evaluate(() => window.marpora.backend.changeOnDisk("# From disk\n\nTwo\n"));
await disk.waitForTimeout(300);
check("reloading drops edits", (await diskText()) === "# From disk\n\nTwo\n" &&
  (await disk.locator("#write p").textContent()) === "Two", await diskText());
await disk.evaluate(() => window.marpora.handleMenu("source-mode"));
await disk.waitForSelector("#typora-source .CodeMirror");
await disk.evaluate(() => window.marpora.backend.changeOnDisk("# From disk\n\nThree\n"));
await disk.waitForTimeout(300);
check("source mode shows the change", (await disk.evaluate(() => window.marpora.source.codeMirror.getValue())) === "# From disk\n\nThree\n");

// AI › Ask AI…: a prompt under the selection; the answer streams into a preview and
// replaces the selection on Enter, as one undo step.
const ai = await browser.newPage({ viewport: { width: 1000, height: 700 } });
ai.on("pageerror", (e) => errors.push(e.message));
await ai.goto(process.env.URL ?? "http://localhost:1420/");
await ai.waitForSelector("#write");
const aiText = () => ai.evaluate(async () => {
  await window.marpora.sync.flush();
  return (await window.marpora.backend.documentText(1)).text;
});
const aiSelect = (word) => ai.evaluate((word) => {
  const { view } = window.marpora;
  let pos = -1;
  view.state.doc.descendants((n, p) => { if (pos < 0 && n.isText && n.text.includes(word)) pos = p + n.text.indexOf(word); });
  const Sel = view.state.selection.constructor;
  view.dispatch(view.state.tr.setSelection(word ? Sel.create(view.state.doc, pos, pos + word.length) : Sel.atEnd(view.state.doc)));
  view.focus();
}, word);
await ai.evaluate(async () => {
  await window.marpora.backend.setText(1, "One two three.\n\nSecond para.\n");
  await window.marpora.sync.resync();
});
const aiBox = ai.locator("#md-ai-inline");
await aiSelect("two");
await ai.evaluate(() => window.marpora.handleMenu("ai-ask"));
await aiBox.waitFor();
check("ai: prompt opens with presets", (await ai.locator(".md-ai-presets li").allTextContents()).includes("Improve Writing") &&
  !(await ai.locator(".md-ai-presets li").allTextContents()).includes("Continue Writing") &&
  (await ai.evaluate(() => document.activeElement?.closest("#md-ai-inline") !== null)));
check("ai: target stays marked", (await ai.locator("#write .md-ai-target").textContent()) === "two");
await ai.evaluate(() => window.marpora.backend.aiReplies.push("**TWO**"));
await ai.keyboard.type("shout it");
await ai.keyboard.press("Enter");
await ai.locator(".md-ai-actions .btn-primary").waitFor();
const aiAsked = await ai.evaluate(() => window.marpora.backend.aiRequests.at(-1));
check("ai: request has the document and the passage", aiAsked.system.includes("<document>\nOne two three.") &&
  aiAsked.messages[0].content.includes("<passage>\ntwo\n</passage>") && aiAsked.messages[0].content.endsWith("shout it"),
  JSON.stringify(aiAsked));
check("ai: answer previewed", (await ai.locator(".md-ai-preview").textContent()) === "**TWO**");
await ai.keyboard.press("Enter");
check("ai: enter replaces the selection", (await aiText()) === "One **TWO** three.\n\nSecond para.\n" &&
  (await aiBox.count()) === 0 && (await ai.locator("#write .md-ai-target").count()) === 0, await aiText());
await ai.keyboard.press("Meta+z");
check("ai: one undo step", (await aiText()) === "One two three.\n\nSecond para.\n", await aiText());
await aiSelect("Second");
await ai.evaluate(() => window.marpora.backend.aiReplies.push("```markdown\n- a\n- b\n```"));
await ai.evaluate(() => window.marpora.handleMenu("ai:summarize"));
await ai.locator(".md-ai-actions .btn-primary").waitFor();
check("ai: preset runs at once", (await ai.evaluate(() => window.marpora.backend.aiRequests.at(-1).messages[0].content)).endsWith("Summarize it in a few sentences."));
await ai.keyboard.press("Alt+Enter");
check("ai: insert below, unfenced", (await aiText()) === "One two three.\n\nSecond para.\n\n- a\n- b\n", await aiText());
await aiSelect("");
await ai.evaluate(() => window.marpora.backend.aiReplies.push("More."));
await ai.evaluate(() => window.marpora.handleMenu("ai:continue"));
await ai.locator(".md-ai-actions .btn-primary").waitFor();
check("ai: continue writes at the cursor", (await ai.evaluate(() => window.marpora.backend.aiRequests.at(-1).messages[0].content)).includes("<before-cursor>") &&
  (await ai.locator(".md-ai-actions .btn-primary").textContent()).startsWith("Insert"));
await ai.keyboard.press("Escape");
check("ai: escape discards", (await aiBox.count()) === 0 && (await aiText()).endsWith("- b\n"), await aiText());
await aiSelect("two");
await ai.evaluate(() => window.marpora.backend.aiReplies.push("error:no Anthropic API key"));
await ai.evaluate(() => window.marpora.handleMenu("ai:fix"));
await ai.locator(".md-ai-error").waitFor();
check("ai: errors show", (await ai.locator(".md-ai-error").textContent()) === "no Anthropic API key");
await ai.mouse.click(900, 650);
check("ai: a click outside closes", (await aiBox.count()) === 0);
await ai.evaluate(() => window.marpora.handleMenu("ai:translate"));
await aiBox.waitFor();
check("ai: translate asks for the language", (await ai.locator(".md-ai-input input").inputValue()) === "Translate it to " &&
  (await ai.evaluate(() => window.marpora.backend.aiRequests.length)) === 4);
await ai.keyboard.press("Escape");
// AI › Custom Prompts: the user's prompt files, from the menu and in the prompt's list.
await ai.evaluate(() => {
  window.marpora.backend.prompts = [{ name: "Make Formal", instruction: "Rewrite it formally." }];
  window.marpora.backend.aiReplies.push("Deux");
});
await aiSelect("two");
await ai.evaluate(() => window.marpora.handleMenu("prompt:Make Formal"));
await ai.locator(".md-ai-actions .btn-primary").waitFor();
check("ai: custom prompt runs from the menu", (await ai.evaluate(() => window.marpora.backend.aiRequests.at(-1).messages[0].content)).endsWith("Rewrite it formally."));
await ai.keyboard.press("Escape");
await aiSelect("two");
await ai.evaluate(() => window.marpora.handleMenu("ai-ask"));
await ai.locator(".md-ai-presets li", { hasText: "Make Formal" }).waitFor({ timeout: 3000 }).catch(() => {});
await ai.keyboard.type("formal");
check("ai: custom prompts in the list", (await ai.locator(".md-ai-presets li").allTextContents()).join() === "Make Formal",
  (await ai.locator(".md-ai-presets li").allTextContents()).join());
await ai.keyboard.press("Escape");
// Preferences › AI › Agents set to ask first: an agent's edit waits for Accept or Reject.
await ai.evaluate(() => {
  const b = window.marpora.backend;
  b.suggest({ id: 1, docId: 1, agent: "claude-code", line: 3, removed: "Second para.\n", added: "Second paragraph.\nThird.\n" });
  b.suggest({ id: 2, docId: 1, agent: "claude-code", line: 1, removed: "One", added: "Uno" });
  b.suggest({ id: 3, docId: 1, agent: "", line: 1, removed: "", added: "New\n" });
});
const agentBar = ai.locator("#md-agent-suggestion");
await agentBar.waitFor();
check("agent: suggestion shows its lines", (await agentBar.locator(".agent-suggestion-head").textContent()).startsWith("claude-code suggests an edit at line 3") &&
  (await agentBar.locator(".agent-del").allTextContents()).join("|") === "Second para." &&
  (await agentBar.locator(".agent-add").allTextContents()).join("|") === "Second paragraph.|Third." &&
  (await agentBar.locator(".agent-suggestion-count").textContent()) === "2 more waiting");
await agentBar.locator(".agent-accept").click();
check("agent: accept answers and shows the next", (await ai.evaluate(() => window.marpora.backend.agentAnswers.join())) === "1 true" &&
  (await agentBar.locator(".agent-add").textContent()) === "Uno");
await agentBar.locator(".agent-trust").click();
check("agent: always allow trusts the agent", (await ai.evaluate(() => window.marpora.backend.agentAnswers.at(-1))) === "2 true claude-code" &&
  (await agentBar.locator(".agent-trust").count()) === 0 && (await agentBar.locator(".agent-suggestion-head b").textContent()) === "An agent");
await agentBar.locator(".agent-reject").click();
check("agent: reject answers and the bar goes", (await ai.evaluate(() => window.marpora.backend.agentAnswers.at(-1))) === "3 false" && (await agentBar.count()) === 0);

// AI › AI Chat: questions carry the document and selection; answers go in on a click.
await ai.evaluate(() => window.marpora.handleMenu("ai-chat"));
const chat = ai.locator("#md-ai-chat");
await chat.waitFor();
// The page slides over (a 0.4 s transition, as the sidebar's).
await ai.waitForFunction(() => getComputedStyle(document.querySelector("content")).right === "320px", null, { timeout: 2000 }).catch(() => {});
check("chat: panel opens beside the page", (await ai.evaluate(() => document.body.classList.contains("ai-chat-open"))) &&
  (await ai.locator("content").evaluate((c) => getComputedStyle(c).right)) === "320px");
await aiSelect("Second");
await ai.evaluate(() => window.marpora.backend.aiReplies.push("It says **hi**.", "Done."));
await chat.locator("textarea").fill("What does it say?");
await chat.locator("textarea").press("Enter");
await chat.locator(".md-ai-chat-assistant:not(.md-ai-chat-streaming)").first().waitFor();
const chatAsked = await ai.evaluate(() => window.marpora.backend.aiRequests.at(-1));
check("chat: question has the document and selection", chatAsked.system.includes("<document>\nOne two three.") &&
  chatAsked.messages.length === 1 && chatAsked.messages[0].content.includes("<selection>\nSecond\n</selection>"), JSON.stringify(chatAsked.messages));
check("chat: shows the conversation", (await chat.locator(".md-ai-chat-text").allTextContents()).join("|") === "What does it say?|It says hi." && (await chat.locator(".md-ai-chat-md strong").textContent()) === "hi");
await chat.locator("textarea").fill("And then?");
await chat.locator("textarea").press("Enter");
await ai.waitForFunction(() => document.querySelectorAll("#md-ai-chat .md-ai-chat-assistant:not(.md-ai-chat-streaming)").length === 2);
const followUp = await ai.evaluate(() => window.marpora.backend.aiRequests.at(-1).messages.map((m) => m.role + ":" + m.content.slice(0, 12)));
check("chat: follow-ups carry the history", followUp.join("|") === "user:My selection|assistant:It says **hi|user:My selection", followUp.join("|"));
await aiSelect("Second");
await chat.locator(".md-ai-chat-assistant").first().getByText("Replace Selection").click();
check("chat: replace the selection", (await aiText()).startsWith("One two three.\n\nIt says **hi**. para.\n"), await aiText());
await ai.evaluate(() => window.marpora.handleMenu("ai-chat"));
check("chat: menu closes it", (await chat.count()) === 0 && !(await ai.evaluate(() => document.body.classList.contains("ai-chat-open"))));
await ai.reload();
await ai.waitForSelector("#write");
await ai.evaluate(() => window.marpora.handleMenu("ai-chat"));
await chat.waitFor();
check("chat: kept across a reload", (await chat.locator(".md-ai-chat-msg").count()) === 4);
await chat.getByText("New Chat").click();
check("chat: new chat clears", (await chat.locator(".md-ai-chat-msg").count()) === 0);
// Folder: the model may search and read the folder's files; the chat shows what it reads.
await chat.locator(".md-ai-chat-folder").click();
await ai.evaluate(() => window.marpora.backend.aiReplies.push("The plan is in plan.md. ".repeat(12)));
await chat.locator("textarea").fill("Where is the plan?");
await chat.locator("textarea").press("Enter");
await chat.locator(".md-ai-chat-tool").waitFor({ timeout: 2000 }).catch(() => {});
check("chat: folder questions say what the model reads", (await chat.locator(".md-ai-chat-tool").textContent().catch(() => "")) === "Listing files…" &&
  (await ai.evaluate(() => window.marpora.backend.aiFolders.at(-1))) === true &&
  (await chat.locator("textarea").getAttribute("placeholder")) === "Ask about this document or folder…");
await chat.locator(".md-ai-chat-actions").first().waitFor();
await ai.reload();
await ai.waitForSelector("#write");
await ai.evaluate(() => window.marpora.handleMenu("ai-chat"));
check("chat: folder setting kept across a reload", (await chat.locator(".md-ai-chat-folder").getAttribute("aria-pressed")) === "true");
await ai.close();

// View › Slide Preview: a Marp deck's slides beside the editor, in step with the text.
// A context of its own, so View › Present's audience page can share its BroadcastChannel.
const deckContext = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const deck = await deckContext.newPage();
deck.on("pageerror", (e) => errors.push(e.message));
await deck.goto(process.env.URL ?? "http://localhost:1420/");
await deck.waitForSelector("#write");
await deck.evaluate(async () => {
  await window.marpora.backend.setText(1, "---\nmarp: true\n---\n\n# One\n\n$$\nx^2\n$$\n\n---\n\n## Two\n\n$e^{i\\pi}$\n\n---\n\n## Three\n");
  await window.marpora.sync.resync();
});
// The editor's MathJax 4 first: Marp's bundled MathJax 3 must load beside it.
await deck.waitForSelector("#write mjx-container", { timeout: 10000 });
await deck.evaluate(() => window.marpora.handleMenu("slide-preview"));
const deckSlides = () => deck.evaluate(() => [...(document.querySelector(".marp-preview-slides")?.shadowRoot?.querySelectorAll("svg[data-marpit-svg]") ?? [])].length);
await deck.waitForFunction(() => document.querySelector(".marp-preview-slides")?.shadowRoot?.querySelectorAll("svg[data-marpit-svg]").length === 3);
check("slides: preview shows the deck", (await deckSlides()) === 3 && (await deck.evaluate(() => document.body.classList.contains("slide-preview-open"))));
check("slides: math from the saved text", await deck.evaluate(() => !!document.querySelector(".marp-preview-slides").shadowRoot.querySelectorAll("svg[data-marpit-svg]")[1].querySelector("mjx-container, .MathJax, svg svg")));
await deck.evaluate(() => {
  const svg = document.querySelector(".marp-preview-slides").shadowRoot.querySelectorAll("svg[data-marpit-svg]")[1];
  svg.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
});
await deck.waitForTimeout(100);
check("slides: a click goes to the slide", (await deck.evaluate(() => {
  const { view } = window.marpora;
  return view.state.doc.resolve(view.state.selection.head).parent.textContent;
})) === "Two" && (await deck.locator(".marp-preview-count").textContent()) === "2 / 3");
await deck.evaluate(() => {
  const { view } = window.marpora;
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atEnd(view.state.doc)));
});
await deck.waitForFunction(() => document.querySelector(".marp-preview-count")?.textContent === "3 / 3");
check("slides: the cursor's slide is marked", await deck.evaluate(() => document.querySelector(".marp-preview-slides").shadowRoot.querySelectorAll("svg[data-marpit-svg]")[2].classList.contains("current")));
await deck.evaluate(async () => {
  const { view } = window.marpora;
  const md = "\n\n---\n\n## Four\n";
  await window.marpora.backend.setText(1, (await window.marpora.backend.documentText(1)).text + md);
  await window.marpora.sync.resync();
});
await deck.waitForFunction(() => document.querySelector(".marp-preview-slides")?.shadowRoot?.querySelectorAll("svg[data-marpit-svg]").length === 4, null, { timeout: 3000 }).catch(() => {});
check("slides: edits show", (await deckSlides()) === 4, String(await deckSlides()));
const deckExport = (id) => deck.evaluate(async (id) => {
  const m = window.marpora;
  m.backend.exports.clear();
  m.handleMenu(id);
  for (let i = 0; i < 200 && !m.backend.exports.size; i++) await new Promise((r) => setTimeout(r, 50));
  return [...m.backend.exports.values()][0] ?? "";
}, id);
// The theme menu: Marp's themes and the user's, and the choice goes into the front matter.
await deck.evaluate(async () => {
  window.marpora.backend.marpThemeCss = ["/* @theme brand */\n@import \"gaia\";\nsection { color: rgb(1, 2, 3); }", "not a theme"];
});
await deck.click(".marp-preview-theme-btn");
await deck.waitForFunction(() => document.querySelectorAll(".marp-preview-theme li[data-theme]").length === 4, null, { timeout: 3000 }).catch(() => {});
const themeItems = await deck.locator(".marp-preview-theme li[data-theme]").evaluateAll((els) => els.map((e) => e.dataset.theme));
check("slides: theme menu lists marp's and the user's themes", themeItems.join() === "default,gaia,uncover,brand", themeItems.join());
await deck.dispatchEvent(".marp-preview-theme li[data-theme='brand'] a", "mousedown");
await deck.waitForFunction(() => document.querySelector(".marp-preview-theme-btn")?.textContent.startsWith("brand"), null, { timeout: 3000 }).catch(() => {});
check("slides: choosing a theme sets theme:", (await deck.evaluate(async () => {
  await window.marpora.sync.flush();
  return (await window.marpora.backend.documentText(1)).text;
})).startsWith("---\nmarp: true\ntheme: brand\n---") && (await deck.evaluate(() =>
  getComputedStyle(document.querySelector(".marp-preview-slides").shadowRoot.querySelector("section")).color)) === "rgb(1, 2, 3)" &&
  !(await deck.locator(".marp-preview-theme .dropdown-menu").count()));
await deck.click(".marp-preview-theme-btn");
await deck.dispatchEvent(".marp-preview-theme li[data-action='folder'] a", "mousedown");
check("slides: theme menu opens the folder", (await deck.evaluate(() => window.marpora.backend.marpThemeFolderOpened)) === 1);
// Back to Marp's default for the checks below.
await deck.evaluate(async () => {
  const m = window.marpora;
  await m.backend.setText(1, (await m.backend.documentText(1)).text.replace("theme: brand\n", ""));
  await m.sync.resync();
});
await deck.waitForFunction(() => document.querySelector(".marp-preview-theme-btn")?.textContent.startsWith("default"));
const deckHtml = await deckExport("export-html");
check("slides: html export is the deck", (deckHtml.match(/<svg[^>]*data-marpit-svg/g) ?? []).length === 4 &&
  deckHtml.includes("<title>untitled</title>") === false && deckHtml.includes("<script>") && !deckHtml.includes('id="write"'), deckHtml.slice(0, 300));
const deckPdf = await deckExport("export-pdf");
check("slides: pdf export at the slide size", deckPdf.startsWith("slides 1280x720\n") && !/<svg[^>]*data-marpit-svg/.test(deckPdf) && (deckPdf.match(/<section/g) ?? []).length === 4 && deckPdf.includes("alignContent"),
  deckPdf.slice(0, 120));
const deckPptx = await deckExport("export-slides-pptx");
check("slides: powerpoint export from the print page with notes", deckPptx.startsWith('pptx 1280x720\n["","","",""]\n') &&
  (deckPptx.match(/<section/g) ?? []).length === 4 && deckPptx.includes("alignContent"), deckPptx.slice(0, 120));
// View › Present Slides: the presenter view here, the audience in its own page.
await deck.evaluate(() => {
  const { view } = window.marpora;
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atStart(view.state.doc)));
  window.marpora.handleMenu("present");
});
await deck.locator("#marp-presenter").waitFor();
await deck.waitForFunction(() => window.marporaAudienceOpened === 1);
const audience = await deckContext.newPage();
audience.on("pageerror", (e) => errors.push(e.message));
await audience.goto((process.env.URL ?? "http://localhost:1420/") + "present.html");
await audience.waitForFunction(() => window.marporaAudience?.state().slides === 4);
const audienceState = () => audience.evaluate(() => window.marporaAudience.state());
check("present: audience gets the deck", (await audienceState()).index === 0 &&
  (await audience.evaluate(() => !!document.getElementById("stage").shadowRoot.querySelector("svg[data-marpit-svg]"))));
check("present: presenter view", (await deck.locator(".presenter-count").textContent()) === "1 / 4" &&
  (await deck.evaluate(() => !!document.querySelector(".presenter-next").shadowRoot.querySelector("svg[data-marpit-svg]"))));
await audience.keyboard.press("ArrowRight");
await deck.waitForFunction(() => document.querySelector(".presenter-count")?.textContent === "2 / 4");
await audience.waitForFunction(() => window.marporaAudience.state().index === 1);
check("present: audience keys move the show", true);
await deck.keyboard.press("End");
await audience.waitForFunction(() => window.marporaAudience.state().index === 3);
await deck.keyboard.press("ArrowRight");
check("present: presenter keys, and no slide past the last", (await deck.locator(".presenter-count").textContent()) === "4 / 4");
await deck.keyboard.press("b");
await audience.waitForFunction(() => window.marporaAudience.state().black === true);
check("present: black screen", await audience.evaluate(() => document.body.classList.contains("black")));
await audience.keyboard.press("Escape");
await deck.waitForFunction(() => !document.querySelector("#marp-presenter"));
check("present: escape ends the show", !(await deck.evaluate(() => document.body.classList.contains("presenting"))) &&
  (await audience.evaluate(() => !document.getElementById("ended").hidden)));
await audience.close();

await deck.evaluate(() => window.marpora.handleMenu("ai-chat"));
check("slides: chat takes the place of the preview", (await deck.locator("#marp-preview").count()) === 0 && (await deck.locator("#md-ai-chat").count()) === 1);
await deck.close();

// Preferences: Typora's markup; changes go to the app, and search marks matches.
const prefs = await browser.newPage({ viewport: { width: 800, height: 600 } });
prefs.on("pageerror", (e) => errors.push(e.message));
await prefs.goto((process.env.URL ?? "http://localhost:1420/") + "preferences.html");
await prefs.waitForSelector(".nav-group-item");
const prefsLog = () => prefs.evaluate(() => window.marporaPrefs.log);
check("prefs: categories", (await prefs.locator(".nav-group-item").allTextContents()).join(",") === "Files,Image,Markdown,Appearance,General,Export,AI");
check("prefs: Files shown first", await prefs.locator(".content[data-index='0'] .input-group-header-title").first().textContent() === "Save & Recover" &&
  (await prefs.locator(".content:not(.display-none)").count()) === 1);
await prefs.getByLabel("Auto Save").check();
check("prefs: Auto Save saved", (await prefs.evaluate(() => window.marporaPrefs.current.autoSave)) === true);
await prefs.click("button[aria-label='Recover Unsaved Drafts']");
await prefs.click("button[aria-label='Clear Recent Folders and Files']");
check("prefs: buttons act", (await prefsLog()).includes("openDraftsFolder") && (await prefsLog()).includes("clearRecent"), (await prefsLog()).join());
await prefs.click(".nav-group-item:text('Markdown')");
await prefs.getByLabel(/Highlight/).check();
check("prefs: flavor change keeps the others", JSON.stringify(await prefs.evaluate(() => window.marporaPrefs.current.flavor)) ===
  JSON.stringify({ inlineMath: false, highlight: true, subscript: false, superscript: false }));
await prefs.selectOption(".content[data-index='2'] select", "false");
check("prefs: math numbering", (await prefs.evaluate(() => window.marporaPrefs.current.autoNumberMath)) === false);
await prefs.click(".nav-group-item:text('Image')");
await prefs.selectOption(".content[data-index='1'] select", "per-file-assets");
check("prefs: image storage", (await prefs.evaluate(() => window.marporaPrefs.current.imageStorage)) === "per-file-assets");
await prefs.click(".nav-group-item:text('Appearance')");
await prefs.selectOption(".content[data-index='3'] select", "marpora-night");
check("prefs: theme", (await prefs.evaluate(() => window.marporaPrefs.current.theme)) === "marpora-night");
await prefs.click(".nav-group-item:text('Export')");
await prefs.selectOption(".content[data-index='5'] select", "marpora-night");
await prefs.getByLabel("Page Break Between Top Headings").check();
await prefs.getByLabel("Append in <head />").fill("<meta name='x'>");
await prefs.getByLabel("Append in <head />").blur();
await prefs.getByLabel("Width").fill("99999");
await prefs.getByLabel("Width").press("Enter");
const exportSettings = await prefs.evaluate(() => {
  const c = window.marporaPrefs.current;
  return [c.exportTheme, c.exportPageBreak, c.exportAppendHead, c.exportImageWidth].join("|");
});
check("prefs: export settings", exportSettings === "marpora-night|true|<meta name='x'>|4000", exportSettings);
await prefs.click(".nav-group-item:text('AI')");
const aiPanel = prefs.locator(".content[data-index='6']");
check("prefs: ai model placeholder", (await aiPanel.getByLabel("Model").getAttribute("placeholder")) === "claude-opus-5-5");
await aiPanel.getByLabel("Provider").selectOption("openai");
await aiPanel.getByLabel("Model").fill("gpt-test");
await aiPanel.getByLabel("Model").blur();
check("prefs: ai provider and model", (await prefs.evaluate(() => [window.marporaPrefs.current.aiProvider, window.marporaPrefs.current.aiModel].join())) === "openai,gpt-test" &&
  (await aiPanel.getByLabel("Endpoint").getAttribute("placeholder")) === "https://api.openai.com/v1");
await aiPanel.getByLabel("Agent edits").selectOption("suggest");
check("prefs: agent edits ask first", (await prefs.evaluate(() => window.marporaPrefs.current.agentEdits)) === "suggest");
const anthropicKey = aiPanel.getByLabel("Anthropic API key", { exact: true });
check("prefs: no key yet", (await anthropicKey.getAttribute("placeholder")) === "Not set");
await anthropicKey.fill("sk-test");
await anthropicKey.press("Enter");
await prefs.waitForFunction(() => document.querySelector("input[aria-label='Anthropic API key']")?.placeholder === "Saved in Keychain");
check("prefs: key saved and not shown", (await anthropicKey.inputValue()) === "" &&
  (await prefs.evaluate(() => window.marporaPrefs.log.at(-1))) === "aiSetKey anthropic set");
await aiPanel.getByLabel("Remove Anthropic API key").click();
await prefs.waitForFunction(() => document.querySelector("input[aria-label='Anthropic API key']")?.placeholder === "Not set");
check("prefs: key removed", (await prefs.evaluate(() => window.marporaPrefs.log.at(-1))) === "aiSetKey anthropic removed");
await prefs.fill(".search-input", "recent");
check("prefs: search marks matches", (await prefs.locator(".input-group.search-hit .input-group-header-title").allTextContents()).join() === "Recent Locations" &&
  (await prefs.locator(".nav-group-item.no-search-hit").allTextContents()).join() === "Image,Markdown,Appearance,General,Export,AI");
await prefs.fill(".search-input", "zzz");
check("prefs: no results", (await prefs.locator(".no-results:not(.display-none)").textContent()) === 'No results found for "zzz"');
await prefs.click(".clear-btn-icon");
check("prefs: search cleared", (await prefs.locator(".search-hit, .no-search-hit").count()) === 0 &&
  (await prefs.locator(".no-results.display-none").count()) === 1);

check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
process.exit(failures ? 1 : 0);
