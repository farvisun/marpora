// What the Files tab and Quick Open show, worked out as Typora does: file summaries,
// "3 minutes ago" dates, natural sort order and Quick Open's match ranking.

import type { LibraryDoc } from "../ipc";

/** `name` as [name, extension], the extension keeping its dot. */
export function splitName(name: string, isDirectory = false): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot < 0 || isDirectory ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
}

const isFenceLine = (line: string) => /^\s*---\s*$/.test(line);

/** Markdown syntax stripped for a summary (Typora's non-strict mode). */
function plain(text: string): string {
  return text
    .replace(/^\s*(([\n#>]+)|([-=*`\s]{3,}))/gm, "")
    .replace(/\s*[*_`$=]+\s*/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gm, "$1");
}

/** A front matter value, continued on more-indented lines. */
function frontMatterValue(lines: string[], at: number, value: string): string {
  const indent = (lines[at].match(/^\s*/) ?? [""])[0].length;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    const lineIndent = (line.match(/^\s*/) ?? [""])[0].length;
    if (isFenceLine(line) || (lineIndent <= indent && line.includes(":"))) return value;
    value += `\n${line}`;
  }
  return value;
}

/**
 * The article list's summary of a file from its first bytes: the title, subtitle and
 * summary from front matter if there is any, else the text without Markdown syntax.
 */
export function summaryOf(text: string): string {
  text = text.replace(/^[﻿​]+/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (!isFenceLine(lines[0])) return plain(text);
  const parts: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      if (parts.length < 3) parts.push(plain(lines.slice(i + 1).join("\n") || text));
      return parts.join("\n");
    }
    const m =
      /^\s*(title)\s*:(.+)$/.exec(lines[i]) ??
      /^\s*(subtitle)\s*:(.+)$/.exec(lines[i]) ??
      /^\s*(overview|summary|description|excerpt)\s*:(.+)$/.exec(lines[i]);
    if (m) {
      const value = frontMatterValue(lines, i, m[2]);
      if (value.trim()) parts.push(value.trim());
    }
  }
  return parts.join("\n");
}

/** Summary lines: a word followed by line breaks ends a line, as Typora renders it. */
export function summaryLines(summary: string): string[] {
  return summary.replace(/([^\s]+)\s*\n+/g, "$1\u0000").split("\u0000");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => (n > 9 ? "" : "0") + n;

/** Typora's file list date: "just now", "5 minutes ago", "14:05", "Yesterday", ... */
export function naturalDate(date: Date, now = new Date()): string {
  const seconds = (now.getTime() - date.getTime()) / 1000;
  if (seconds < 30) return "just now";
  if (seconds < 60) return "1 minutes ago";
  if (seconds < 3600) return `${Math.floor((30 + seconds) / 60)} minutes ago`;
  if (seconds < 18000 && now.getDay() === date.getDay()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (seconds < 172800 && now.getDay() === (date.getDay() + 1) % 7) return "Yesterday";
  if (seconds < 518400) return `${Math.floor(seconds / 86400)} days ago`;
  if (now.getFullYear() === date.getFullYear()) return `${MONTHS[date.getMonth()]} ${pad(date.getDate())}`;
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

const CHUNK = /([.,\s+-]+|\d+)/;
const MONTH =
  /^(?:(jan(?:uary)?)|(feb(?:ruary)?)|(mar(?:ch)?)|(apr(?:il))|(may)|(jun(?:e)?)|(jul(?:y)?)|(aug(?:ust)?)|(sep(?:tember)?)|(oct(?:ober)?)|(nov(?:ember)?)|(dec(?:ember)?))$/;

function monthIndex(word: string): number {
  const m = MONTH.exec(word);
  return m ? m.findIndex((g, i) => i > 0 && !!g) : -1;
}

/** Typora's natural order: numbers by value, month names by month, the rest by locale. */
export function naturalCompare(a: string, b: string): number {
  const xs = a.toLowerCase().split(CHUNK).filter(Boolean);
  const ys = b.toLowerCase().split(CHUNK).filter(Boolean);
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const [x, y] = [xs[i], ys[i]];
    if (x === y) continue;
    const [xn, yn] = [/^\d/.test(x), /^\d/.test(y)];
    let d: number;
    if (xn && yn) d = Number(x) - Number(y);
    else if (xn || yn) d = xn ? 1 : -1;
    else {
      const [xm, ym] = [monthIndex(x), monthIndex(y)];
      d = xm > 0 && ym > 0 ? xm - ym : x.localeCompare(y);
    }
    if (d) return d;
  }
  return xs.length - ys.length;
}

export interface FolderGroup {
  folder: string;
  files: LibraryDoc[];
}

/** Typora's sidebar orders; negative is descending. */
export const SortType = {
  CreateDateDescend: -3,
  DateDescend: -2,
  AlphabetDescend: -1,
  NaturalDescend: -10,
  Natural: 0,
  Alphabet: 1,
  Date: 2,
  CreateDate: 3,
} as const;

/** Typora's name order: by the part before the first dot, ignoring case. */
function compareNames(a: string, b: string): number {
  if (a === b) return 0;
  a = a.toLowerCase();
  b = b.toLowerCase();
  const [sa, sb] = [a.replace(/\..+/, ""), b.replace(/\..+/, "")];
  return sa === sb ? a.localeCompare(b) : sa.localeCompare(sb);
}

/** A comparator for sort type `sort` (Typora's `compareItem`). */
export function compareItems(sort: number) {
  return (a: { name: string; modified: number; created: number }, b: typeof a): number => {
    switch (sort) {
      case SortType.Alphabet:
        return compareNames(a.name, b.name);
      case SortType.AlphabetDescend:
        return compareNames(b.name, a.name);
      case SortType.Date:
        return a.modified - b.modified;
      case SortType.DateDescend:
        return b.modified - a.modified;
      case SortType.CreateDate:
        return a.created - b.created;
      case SortType.CreateDateDescend:
        return b.created - a.created;
      case SortType.NaturalDescend:
        return -naturalCompare(a.name, b.name);
      default:
        return naturalCompare(a.name, b.name);
    }
  };
}

/** Files by folder, folders in the order found, each sorted by `sort`. With `noGroup`,
 * one group of every file. */
export function groupByFolder(files: LibraryDoc[], sort = 0, noGroup = false): FolderGroup[] {
  const compare = compareItems(sort);
  if (noGroup) return files.length ? [{ folder: "", files: [...files].sort(compare) }] : [];
  const groups = new Map<string, LibraryDoc[]>();
  for (const f of files) {
    const g = groups.get(f.folder);
    if (g) g.push(f);
    else groups.set(f.folder, [f]);
  }
  return [...groups].map(([folder, files]) => ({ folder, files: files.sort(compare) }));
}

/** One level of the file tree: folders, then files, each sorted; mixed with `noGroup`. */
export function sortEntries<T extends { name: string; modified: number; created: number; isDirectory: boolean }>(
  entries: T[],
  sort = 0,
  noGroup = false,
): T[] {
  const compare = compareItems(sort);
  if (noGroup) return [...entries].sort(compare);
  const of = (dir: boolean) => entries.filter((e) => e.isDirectory === dir).sort(compare);
  return [...of(true), ...of(false)];
}

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));

/** `path` with the home folder written as `~`. */
export function abbreviate(path: string, home: string | null): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// ---- Quick Open ------------------------------------------------------------

export interface QuickItem {
  name: string;
  path: string;
  /** Modified time, newest first among equal scores. */
  modified: number;
}

/** The query's words as patterns; `*` matches anything. */
export function queryTerms(query: string): string[] {
  return query
    .replace(/[()'"%\\/.?]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
}

/** How well `term` matches `text`: 4 for a match at a word start and end, less inside words, 0 for none. */
function termScore(text: string, term: RegExp): number {
  const m = term.exec(text.normalize());
  if (!m) return 0;
  const before = m[1] ?? "";
  const after = m[3] ?? "";
  return 4 - before.length - (/\w/.test(before) ? 1 : 0) - (/\w/.test(after) ? 1 : 0);
}

/** Where Quick Open shows a file: relative to the library folder's parent, else from home. */
export function quickPath(path: string, root: string | null, home: string | null): string {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  if (root && dir.startsWith(`${root}/`)) return dir.slice(root.lastIndexOf("/") + 1);
  const shown = abbreviate(dir, home);
  return shown.length > 60 ? `${shown.slice(0, 30)}...${shown.slice(-30)}` : shown;
}

/**
 * Items matching every term of `query`, best first. A term in the name counts double;
 * files in the library folder get a bonus. With no query, files in the folder come
 * first, newest first.
 */
export function rankQuick(items: QuickItem[], query: string, root: string | null, home: string | null): QuickItem[] {
  const inRoot = (p: string) => !!root && p.startsWith(`${root}/`);
  const terms = queryTerms(query).map((t) => new RegExp(`(.)?(${t})(.)?`, "i"));
  if (!terms.length)
    return [...items].sort((a, b) => Number(inRoot(b.path)) - Number(inRoot(a.path)) || b.modified - a.modified);
  const scored: [QuickItem, number][] = [];
  for (const item of items) {
    let score = 0;
    for (const term of terms) {
      const s = 2 * termScore(item.name, term) || termScore(quickPath(item.path, root, home), term);
      if (!s) {
        score = 0;
        break;
      }
      score += s;
    }
    if (!score) continue;
    scored.push([item, score + (inRoot(item.path) ? 3 : 0)]);
  }
  return scored.sort((a, b) => b[1] - a[1] || b[0].modified - a[0].modified).map(([item]) => item);
}

/** `text` split into [plain, matched] runs for the query's terms (shown bold). */
export function highlight(text: string, query: string): [string, boolean][] {
  const terms = queryTerms(query);
  if (!terms.length) return [[text, false]];
  const re = new RegExp(`(${terms.join("|")})`, "gi");
  const out: [string, boolean][] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > at) out.push([text.slice(at, m.index), false]);
    out.push([m[0], true]);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push([text.slice(at), false]);
  return out;
}
