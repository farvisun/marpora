// Copy and paste as Typora does them: a copy puts the selection's Markdown on the
// clipboard as its plain text, and pasted plain text is read as Markdown. HTML copied
// from this editor (or another ProseMirror one) is pasted from that Markdown too, which
// keeps math, HTML and the rest that the HTML would lose; other HTML goes through the
// schema's parse rules. A pasted image is stored (see src-tauri images.rs) and shown.

import { Fragment, type Node as PMNode, Slice } from "prosemirror-model";
import { Plugin, PluginKey, Selection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { report } from "../ipc";
import { parseMarkdown, serializeBlocks } from "../md";
import { schema } from "./schema";

export interface ClipboardOptions {
  /** Store a pasted image; returns how the document refers to it. */
  saveImage?(image: Blob): Promise<string>;
}

/** The Markdown for a copied slice. Copies hold their enclosing blocks (open where the
 * selection cuts them), so list items stay in their list. */
export function sliceMarkdown(slice: Slice): string {
  let content = slice.content;
  if (content.firstChild?.isInline) content = Fragment.from(schema.nodes.paragraph.create(null, content));
  const blocks: PMNode[] = [];
  content.forEach((node) => blocks.push(node));
  return serializeBlocks(blocks).join("\n\n");
}

/** Pasted Markdown as a slice; a paragraph at either end joins the text around it.
 * One paragraph keeps the spaces around it, which Markdown would drop. */
export function markdownSlice(text: string): Slice {
  const { doc } = parseMarkdown(text);
  if (!doc.childCount) return Slice.empty;
  const paragraph = schema.nodes.paragraph;
  const only = doc.childCount === 1 ? doc.firstChild : null;
  if (only?.type === paragraph) {
    const lead = /^[ \t]*/.exec(text)?.[0] ?? "";
    const trail = /[ \t]*\n*$/.exec(text)?.[0].replace(/\n/g, "") ?? "";
    const parts = [lead && schema.text(lead), ...only.content.content, trail && schema.text(trail)].filter(Boolean);
    return new Slice(Fragment.from(paragraph.create(null, parts as PMNode[])), 1, 1);
  }
  const open = (node: PMNode | null) => (node?.type === paragraph ? 1 : 0);
  return new Slice(doc.content, open(doc.firstChild), open(doc.lastChild));
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};

export function imageExtension(type: string): string | null {
  return EXTENSIONS[type] ?? null;
}

/** Insert images at the selection, named as Typora names them: by their file's stem. */
export function insertImages(view: EditorView, srcs: string[]) {
  const nodes = srcs.map((src) =>
    schema.nodes.image.create({ src, alt: (src.split("/").pop() ?? "").replace(/\.[^.]*$/, "") }),
  );
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView());
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)$/i;
const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd|txt)$/i;

/** Files dropped from Finder at page point (`x`, `y`), as Typora takes them: images go
 * in where they land, other files as links to them; Markdown files are left to
 * `open`. `src` says how the document refers to a file. */
export function dropFiles(
  view: EditorView,
  paths: string[],
  x: number,
  y: number,
  src: (path: string) => string,
  open: (path: string) => void,
) {
  const markdown = paths.filter((p) => MARKDOWN_FILE.test(p));
  const others = paths.filter((p) => !MARKDOWN_FILE.test(p));
  if (others.length) {
    const at = view.posAtCoords({ left: x, top: y });
    if (at) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(at.pos))));
    const images = others.filter((p) => IMAGE_FILE.test(p));
    if (images.length) insertImages(view, images.map(src));
    for (const p of others.filter((p) => !IMAGE_FILE.test(p))) {
      const name = p.split("/").pop() ?? p;
      const link = schema.marks.link.create({ href: src(p) });
      view.dispatch(view.state.tr.replaceSelectionWith(schema.text(name, [link]), false).scrollIntoView());
    }
    view.focus();
  }
  for (const p of markdown) open(p);
}

export function clipboardPlugin(opts: ClipboardOptions): Plugin {
  return new Plugin({
    key: new PluginKey("marpora-clipboard"),
    props: {
      // Inside a code, math or HTML block, the text as it is.
      clipboardTextSerializer: (slice, view) => {
        const { $from, $to } = view.state.selection;
        if ($from.parent.type.spec.code && $from.sameParent($to)) return $from.parent.textBetween($from.parentOffset, $to.parentOffset);
        return sliceMarkdown(slice);
      },
      // Shift-paste (Paste as Plain Text) keeps ProseMirror's own plain text reading.
      clipboardTextParser: (text, _$context, plain) => (plain ? (null as unknown as Slice) : markdownSlice(text)),
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data || view.state.selection.$from.parent.type.spec.code) return false;
        const html = data.getData("text/html");
        const images = [...data.files].filter((f) => imageExtension(f.type));
        if (images.length && !html && opts.saveImage) {
          const save = opts.saveImage;
          void Promise.all(images.map((f) => save(f))).then((srcs) => insertImages(view, srcs), report);
          return true;
        }
        const text = data.getData("text/plain");
        if (html.includes("data-pm-slice") && text) {
          view.dispatch(view.state.tr.replaceSelection(markdownSlice(text)).scrollIntoView());
          return true;
        }
        return false;
      },
    },
  });
}
