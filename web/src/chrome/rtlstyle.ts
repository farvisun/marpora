// How right-to-left blocks look under any theme, and the font right-to-left letters show
// in. View only: exports and the file are untouched.
//
// Themes are written for left-to-right text (`ul { padding-left }`, `blockquote
// { border-left }`, the task checkbox's `margin-left`). Rather than guess each theme's
// values, a hidden copy of those elements is measured once the theme applies, and
// `[dir=rtl]` rules swap their left and right sides.
//
// The font is a `@font-face` family limited to the Arabic script by `unicode-range`, put
// first in every `font-family` the page's style sheets declare: Persian letters take the
// chosen font, everything else keeps the theme's.

import { ALERTS } from "../editor/alert";

export const RTL_FAMILY = "Marpora RTL";
/** Arabic script (Persian included), its presentation forms, and ZWNJ/ZWJ. */
const RANGE = "U+0600-06FF, U+0750-077F, U+0870-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200D";

function styleElement(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
  }
  // Last in <head>, after the theme, so these win ties.
  document.head.append(el);
  return el;
}

/** The `@font-face` rules for installed font `font` at `scale` percent. */
export function fontFaces(font: string, scale: number): string {
  const name = font.replace(/["\\;{}\n\r]/g, "").trim();
  if (!name) return "";
  const size = Number.isFinite(scale) && scale > 0 ? scale : 100;
  const face = (weight: string, names: string[]) =>
    `@font-face { font-family: "${RTL_FAMILY}"; font-weight: ${weight}; src: ${names.map((n) => `local("${n}")`).join(", ")}; unicode-range: ${RANGE}; size-adjust: ${size}%; }`;
  return [
    face("1 549", [name, `${name} Regular`, `${name}-Regular`]),
    // Without a bold face the regular one is made bold.
    face("550 1000", [`${name} Bold`, `${name}-Bold`]),
  ].join("\n");
}

/** Show right-to-left letters in installed font `font`, `scale` percent of their size. */
export function setRtlFont(font: string, scale: number) {
  styleElement("marpora-rtl-font").textContent = fontFaces(font, scale);
  preferRtlFont();
}

const PREFIX = `"${RTL_FAMILY}", `;

function preferIn(rules: CSSRuleList) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const family = rule.style.getPropertyValue("font-family");
      if (family && !family.startsWith(PREFIX) && family !== "inherit" && family !== "initial" && family !== "unset") {
        rule.style.setProperty("font-family", PREFIX + family, rule.style.getPropertyPriority("font-family"));
      }
    }
    if ("cssRules" in rule && rule.cssRules) preferIn(rule.cssRules as CSSRuleList);
  }
}

/** Put the right-to-left family first in each `font-family` of the page's style sheets
 * (again after a theme loads; rules already done are left alone). */
export function preferRtlFont() {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // Another origin's sheet.
    }
    preferIn(rules);
  }
}

/** Elements whose sides are swapped in right-to-left blocks: a selector for the real one,
 * and the markup measured. */
const MIRRORED: [string, string][] = [
  ["ul", `<ul class="ul-list" mdtype="list"><li class="md-list-item"><p>x</p></li></ul>`],
  ["ol", `<ol class="ol-list" mdtype="list"><li class="md-list-item"><p>x</p></li></ol>`],
  ["li.md-list-item", `<ul class="ul-list"><li class="md-list-item"><p>x</p></li></ul>`],
  ["blockquote", `<blockquote mdtype="blockquote"><p>x</p></blockquote>`],
  ...ALERTS.map((type): [string, string] => [
    `.md-alert.md-alert-${type}`,
    `<div class="md-alert md-alert-${type}" mdtype="blockquote"><p>x</p></div>`,
  ]),
];

const TASK = `<ul class="ul-list"><li class="md-list-item md-task-list-item task-list-item task-list-not-done"><input type="checkbox"><p>x</p></li></ul>`;

/** A rule giving `selector` the measured `style` with left and right swapped. */
function swapped(selector: string, s: CSSStyleDeclaration, margins: boolean): string {
  const v = (p: string) => s.getPropertyValue(p);
  const decls = [
    `padding-left: ${v("padding-right")}`,
    `padding-right: ${v("padding-left")}`,
    `border-left: ${v("border-right-width")} ${v("border-right-style")} ${v("border-right-color")}`,
    `border-right: ${v("border-left-width")} ${v("border-left-style")} ${v("border-left-color")}`,
  ];
  // Block margins are left alone: a block's used right margin fills the line.
  if (margins) decls.push(`margin-left: ${v("margin-right")}`, `margin-right: ${v("margin-left")}`);
  return `${selector} { ${decls.join("; ")}; }`;
}

/** Measure the theme's list, quote and task styles in a hidden copy of `write` and swap
 * their sides for right-to-left blocks. Call after each theme change. */
export function mirrorTheme(write: HTMLElement) {
  // The editor mounts before its element joins the page; measure once it has.
  if (!write.isConnected) return void requestAnimationFrame(() => mirrorTheme(write));
  const host = write.parentElement;
  if (!host) return;
  // A sibling with #write's id and classes, so the theme's selectors match it; outside
  // the editor, whose content ProseMirror watches.
  const probe = document.createElement("div");
  probe.id = "write";
  probe.className = write.className;
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, { position: "absolute", visibility: "hidden", pointerEvents: "none", left: "-100000px", top: "0" });
  probe.innerHTML = MIRRORED.map(([, html]) => html).join("") + TASK;
  // The live element keeps its id; the probe goes after it, so getElementById still finds the editor.
  host.append(probe);
  const rules: string[] = [];
  const kids = Array.from(probe.children) as HTMLElement[];
  MIRRORED.forEach(([selector], i) => {
    const el = selector.startsWith("li") ? kids[i].firstElementChild : kids[i];
    if (el) rules.push(swapped(`#write ${selector}[dir="rtl"]`, getComputedStyle(el), false));
  });
  const input = probe.querySelector(".md-task-list-item > input");
  if (input) {
    rules.push(swapped(`#write .md-task-list-item[dir="rtl"] > input`, getComputedStyle(input), true));
  }
  probe.remove();
  styleElement("marpora-rtl-mirror").textContent = rules.join("\n");
}
