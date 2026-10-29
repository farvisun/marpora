import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const modules = fileURLToPath(new URL("./node_modules/", import.meta.url));

/**
 * Packages served under `/vendor/<name>/` in their own layout, because their loaders
 * build URLs at run time (MathJax extensions and font chunks). `include` picks the files
 * the app can load, by path inside the package.
 */
const VENDOR: { name: string; include: (path: string) => boolean }[] = [
  { name: "mathjax", include: (p) => p === "tex-svg.js" || /^(input|output|a11y|ui|adaptors)\/.*\.js$/.test(p) },
  { name: "@mathjax/mathjax-newcm-font", include: (p) => /^svg\/dynamic\/.*\.js$/.test(p) },
];

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
  });
}

/** File for a URL path below `/vendor/`, or null when it is not a vendored file. */
function vendorFile(url: string): string | null {
  const path = normalize(decodeURIComponent(url.split("?")[0])).replace(/^\/+/, "");
  for (const { name, include } of VENDOR) {
    if (!path.startsWith(name + "/")) continue;
    const rest = path.slice(name.length + 1);
    const file = join(modules, name, rest);
    if (!rest.includes("..") && include(rest) && existsSync(file)) return file;
  }
  return null;
}

function vendor(): Plugin {
  return {
    name: "marpora-vendor",
    configureServer(server) {
      server.middlewares.use("/vendor", (req, res, next) => {
        const file = vendorFile(req.url ?? "");
        if (!file) return next();
        res.setHeader("Content-Type", "text/javascript");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const { name, include } of VENDOR) {
        const dir = join(modules, name);
        for (const path of walk(dir).filter(include)) {
          this.emitFile({ type: "asset", fileName: `vendor/${name}/${path}`, source: readFileSync(join(dir, path)) });
        }
      }
    },
  };
}

// Tauri expects a fixed port and does not need the browser to open.
export default defineConfig({
  plugins: [solid(), vendor()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Loaded on demand; listed so the dev server doesn't discover them late and reload.
  optimizeDeps: { include: ["mermaid", "flowchart.js", "raphael", "lodash/core"] },
  build: {
    target: "safari16",
    sourcemap: true,
    rollupOptions: { input: { main: "index.html", preferences: "preferences.html" } },
    // CodeMirror modes load on demand (src/cm.ts); inlining them would bloat the bundle.
    assetsInlineLimit: (file) => (file.includes("/codemirror/") ? false : undefined),
  },
  test: { environment: "jsdom" },
});
