// Screenshot the editor in WebKit: `node test/shot.mjs out.png [width height]`.
// Prints console errors from the page.
import { webkit } from "playwright";

const [out = "shot.png", w = "1100", h = "760"] = process.argv.slice(2);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`[${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(process.env.URL ?? "http://localhost:1420/");
await page.waitForSelector("#write");
await page.waitForTimeout(500);
if (process.env.SCRIPT) await eval(`(async () => { ${process.env.SCRIPT} })()`);
await page.screenshot({ path: out });
await browser.close();
