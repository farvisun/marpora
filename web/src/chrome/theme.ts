// Theme switching. Bundled themes are static files; others (the user's, Typora's) arrive
// as CSS text whose relative url()s are rewritten to asset URLs, because the asset
// protocol encodes the whole path and the browser cannot resolve them itself.

import type { Backend } from "../ipc";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function element<K extends "link" | "style">(id: string, tag: K): HTMLElementTagNameMap[K] {
  const existing = document.getElementById(id);
  if (existing?.tagName.toLowerCase() === tag) return existing as HTMLElementTagNameMap[K];
  existing?.remove();
  const el = document.createElement(tag);
  el.id = id;
  document.head.append(el);
  return el;
}

/** Point relative `url()` and `@import` references in `css` at files under `dir`. */
export function rebaseCss(css: string, dir: string, resolve: (base: string, rel: string) => string): string {
  const rebase = (ref: string) => {
    if (URL_SCHEME.test(ref) || ref.startsWith("#") || ref.startsWith("//")) return ref;
    return resolve(`${dir}/theme.css`, ref.replace(/[?#].*$/, ""));
  };
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, q: string, ref: string) => `url(${q}${rebase(ref.trim())}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/g, (_, q: string, ref: string) => `@import ${q}${rebase(ref)}${q}`);
}

/** Apply theme `id`; returns the id actually applied (bundled default if `id` is gone). */
export async function applyTheme(backend: Backend, id: string): Promise<string> {
  const theme = await backend.loadTheme(id).catch(() => null);
  if (!theme) return id === "marpora" ? id : applyTheme(backend, "marpora");
  const resolve = (base: string, rel: string) => backend.assetUrl(base, rel);

  if (theme.css === null) {
    const link = element("theme-css", "link");
    link.rel = "stylesheet";
    const href = `${import.meta.env.BASE_URL}themes/${id}.css`;
    if (link.getAttribute("href") !== href) {
      // Resolve once the CSS applies: diagrams redraw from the theme's variables.
      const loaded = new Promise((done) => link.addEventListener("load", done, { once: true }));
      const failed = new Promise((done) => link.addEventListener("error", done, { once: true }));
      link.href = href;
      await Promise.race([loaded, failed]);
    }
  } else {
    element("theme-css", "style").textContent = rebaseCss(theme.css, theme.dir ?? "", resolve);
  }
  // User overrides go after the theme so they win.
  const user = element("theme-user-css", "style");
  user.textContent = theme.user.map(([css, dir]) => rebaseCss(css, dir, resolve)).join("\n");
  document.head.append(user);
  document.body.dataset.theme = id;
  return id;
}

/** Theme `id`'s CSS, with the user's additions, as text whose references are absolute
 * URLs (a separate export theme); null when it is gone. */
export async function themeCss(backend: Backend, id: string): Promise<string | null> {
  const theme = await backend.loadTheme(id).catch(() => null);
  if (!theme) return null;
  const resolve = (base: string, rel: string) => backend.assetUrl(base, rel);
  let main: string;
  if (theme.css === null) {
    const href = new URL(`${import.meta.env.BASE_URL}themes/${id}.css`, location.href).href;
    const css = await fetch(href).then((r) => (r.ok ? r.text() : ""));
    main = rebaseCss(css, href.slice(0, href.lastIndexOf("/")), (base, rel) => new URL(rel, base).href);
  } else {
    main = rebaseCss(theme.css, theme.dir ?? "", resolve);
  }
  return [main, ...theme.user.map(([css, dir]) => rebaseCss(css, dir, resolve))].join("\n");
}
