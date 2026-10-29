// Table editing as Typora does it: Paragraph › Table's commands, and the toolbar over the
// table holding the cursor (Typora's `.ty-table-edit`: resize, column alignment, delete).
// Commands rebuild the table from a grid of cells, so each is one undo step.

import { Fragment, type Node as PMNode, Slice } from "prosemirror-model";
import { type Command, type EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { sliceMarkdown } from "./clipboard";
import { schema } from "./schema";

const n = schema.nodes;

type Align = "left" | "center" | "right" | null;

/** Where the cursor is in a table: the table, its position, and the cell's row (0 is the
 * header row) and column. */
export interface TableAt {
  table: PMNode;
  pos: number;
  row: number;
  col: number;
}

export function tableAt(state: EditorState): TableAt | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type !== n.table) continue;
    // table > head|body > row > cell
    if ($from.depth < d + 3) return { table: $from.node(d), pos: $from.before(d), row: 0, col: 0 };
    const head = $from.node(d + 1).type === n.table_head;
    return { table: $from.node(d), pos: $from.before(d), row: head ? 0 : $from.index(d + 1) + 1, col: $from.index(d + 2) };
  }
  return null;
}

/** The table's cells, header row first. */
function grid(table: PMNode): PMNode[][] {
  const rows: PMNode[][] = [];
  table.forEach((section) => section.forEach((row) => rows.push([...row.children])));
  return rows;
}

function aligns(rows: PMNode[][]): Align[] {
  return rows[0].map((c) => c.attrs.align as Align);
}

/** A table from `rows` of cell contents, with the columns aligned as `align`. */
function build(rows: Fragment[][], align: Align[]): PMNode {
  const row = (cells: Fragment[], header: boolean) =>
    n.table_row.create(
      null,
      cells.map((content, i) => (header ? n.table_header : n.table_cell).create({ align: align[i] ?? null }, content)),
    );
  return n.table.create(null, [
    n.table_head.create(null, row(rows[0], true)),
    n.table_body.create(
      null,
      rows.slice(1).map((r) => row(r, false)),
    ),
  ]);
}

/** Position just inside cell (`row`, `col`) of the table at `pos`. */
function cellStart(table: PMNode, pos: number, row: number, col: number): number {
  let at = pos + 1;
  const head = table.child(0);
  if (row === 0) at += 1;
  else {
    at += head.nodeSize + 1;
    for (let i = 1; i < row; i++) at += table.child(1).child(i - 1).nodeSize;
  }
  const r = row === 0 ? head.child(0) : table.child(1).child(row - 1);
  at += 1;
  for (let i = 0; i < col; i++) at += r.child(i).nodeSize;
  return at + 1;
}

/** Edit the cursor's table: `edit` gets its cell contents and alignment and returns the
 * new ones and the cell to put the cursor in, or null if it does not apply. */
function editTable(
  edit: (rows: Fragment[][], align: Align[], at: TableAt) => { rows: Fragment[][]; align: Align[]; row: number; col: number } | null,
): Command {
  return (state, dispatch) => {
    const at = tableAt(state);
    if (!at) return false;
    const cells = grid(at.table);
    const result = edit(
      cells.map((r) => r.map((c) => c.content)),
      aligns(cells),
      at,
    );
    if (!result) return false;
    if (dispatch) {
      const table = build(result.rows, result.align);
      const tr = state.tr.replaceWith(at.pos, at.pos + at.table.nodeSize, table);
      const row = Math.min(result.row, result.rows.length - 1);
      const col = Math.min(result.col, result.rows[0].length - 1);
      tr.setSelection(TextSelection.create(tr.doc, cellStart(table, at.pos, row, col)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

const empty = (cols: number) => Array.from({ length: cols }, () => Fragment.empty);

/** Add a row above or below the cursor's; the header row only has rows below it. */
export function addRow(below: boolean): Command {
  return editTable((rows, align, at) => {
    if (!below && at.row === 0) return null;
    const index = below ? at.row + 1 : at.row;
    rows.splice(index, 0, empty(rows[0].length));
    return { rows, align, row: index, col: at.col };
  });
}

export function addColumn(after: boolean): Command {
  return editTable((rows, align, at) => {
    const index = after ? at.col + 1 : at.col;
    for (const r of rows) r.splice(index, 0, Fragment.empty);
    align.splice(index, 0, null);
    return { rows, align, row: at.row, col: index };
  });
}

/** Swap the cursor's row with the one above or below it; the header row stays. */
export function moveRow(up: boolean): Command {
  return editTable((rows, align, at) => {
    const to = up ? at.row - 1 : at.row + 1;
    if (at.row === 0 || to < 1 || to >= rows.length) return null;
    [rows[at.row], rows[to]] = [rows[to], rows[at.row]];
    return { rows, align, row: to, col: at.col };
  });
}

export function moveColumn(left: boolean): Command {
  return editTable((rows, align, at) => {
    const to = left ? at.col - 1 : at.col + 1;
    if (to < 0 || to >= rows[0].length) return null;
    for (const r of [...rows, align] as unknown[][]) [r[at.col], r[to]] = [r[to], r[at.col]];
    return { rows, align, row: at.row, col: to };
  });
}

export const deleteTable: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(at.pos, at.pos + at.table.nodeSize, n.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, at.pos + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Delete the cursor's row; the header row clears instead, as there must be one. */
export const deleteRow: Command = (state, dispatch, view) => {
  const at = tableAt(state);
  if (at && at.row > 0 && at.table.child(1).childCount === 1 && !at.table.child(0).textContent) {
    return deleteTable(state, dispatch, view);
  }
  return editTable((rows, align, at) => {
    if (at.row === 0) rows[0] = empty(rows[0].length);
    else rows.splice(at.row, 1);
    return { rows, align, row: Math.max(0, at.row === 0 ? 0 : at.row - 1), col: at.col };
  })(state, dispatch, view);
};

/** Delete the cursor's column, or the table with its last column. */
export const deleteColumn: Command = (state, dispatch, view) => {
  const at = tableAt(state);
  if (at && at.table.child(0).child(0).childCount === 1) return deleteTable(state, dispatch, view);
  return editTable((rows, align, at) => {
    for (const r of rows) r.splice(at.col, 1);
    align.splice(at.col, 1);
    return { rows, align, row: at.row, col: Math.max(0, at.col - 1) };
  })(state, dispatch, view);
};

/** Align the cursor's column; aligning it as it already is clears the alignment. */
export function alignColumn(to: Exclude<Align, null>): Command {
  return editTable((rows, align, at) => {
    align[at.col] = align[at.col] === to ? null : to;
    return { rows, align, row: at.row, col: at.col };
  });
}

/** Typora's resize: `cols` columns and `rows` rows, the header row included. */
export function resizeTable(cols: number, rowCount: number): Command {
  return editTable((rows, align, at) => {
    const width = Math.max(1, cols);
    const height = Math.max(1, rowCount);
    const sized = Array.from({ length: height }, (_, r) =>
      Array.from({ length: width }, (_, c) => rows[r]?.[c] ?? Fragment.empty),
    );
    return { rows: sized, align: Array.from({ length: width }, (_, c) => align[c] ?? null), row: at.row, col: at.col };
  });
}

/** Paragraph › Table › Copy Table: the table's Markdown. */
export function tableMarkdown(state: EditorState): string | null {
  const at = tableAt(state);
  return at ? sliceMarkdown(new Slice(Fragment.from(at.table), 0, 0)) : null;
}

const key = new PluginKey("marpora-table");

/** Marks the table holding the cursor, whose view then shows the toolbar. */
export const tablePlugin = new Plugin({
  key,
  props: {
    decorations(state) {
      const at = tableAt(state);
      if (!at) return null;
      const spec = { tableEdit: true, col: at.col, align: at.table.child(0).child(0).child(at.col)?.attrs.align ?? null };
      return DecorationSet.create(state.doc, [Decoration.node(at.pos, at.pos + at.table.nodeSize, {}, spec)]);
    },
  },
});

const SVG = "http://www.w3.org/2000/svg";

/** Our own drawings of Typora's toolbar icons, 14px on a 14 grid. */
const ICONS: Record<string, string> = {
  "ty-menu": "M2 3.5h10M2 7h10M2 10.5h10",
  "ty-left-alignment": "M2 3h10M2 6h6M2 9h10M2 12h6",
  "ty-justify-align": "M2 3h10M4 6h6M2 9h10M4 12h6",
  "ty-right-alignment": "M2 3h10M6 6h6M2 9h10M6 12h6",
  "ty-delete": "M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.7 8.5h5.6l.7-8.5M6 6v4M8 6v4",
};

function icon(name: string): HTMLElement {
  const span = document.createElement("span");
  span.className = `ty-icon ${name}`;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  svg.append(path);
  span.append(svg);
  return span;
}

function button(cls: string, hint: string, iconName: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn btn-default ${cls}`;
  b.setAttribute("ty-hint", hint);
  b.setAttribute("aria-label", hint);
  b.append(icon(iconName));
  return b;
}

const GRID_ROWS = 10;
const GRID_COLS = 6;

/** A table, with Typora's toolbar over it while it holds the cursor. */
export class TableView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private toolbar: HTMLElement | null = null;
  private popover: HTMLElement | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    decorations: readonly Decoration[],
  ) {
    this.dom = document.createElement("figure");
    this.dom.className = "md-table-fig";
    this.dom.setAttribute("mdtype", "table");
    this.contentDOM = document.createElement("table");
    this.contentDOM.className = "md-table";
    this.dom.append(this.contentDOM);
    this.decorate(decorations);
  }

  update(node: PMNode, decorations: readonly Decoration[]) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.decorate(decorations);
    return true;
  }

  private decorate(decorations: readonly Decoration[]) {
    const spec = decorations.map((d) => (d as unknown as { spec: Record<string, unknown> }).spec).find((s) => s?.tableEdit);
    if (!spec) {
      this.toolbar?.remove();
      this.toolbar = this.popover = null;
      return;
    }
    if (!this.toolbar) this.toolbar = this.renderToolbar();
    if (this.toolbar.parentNode !== this.dom) this.dom.insertBefore(this.toolbar, this.contentDOM);
    const group = this.toolbar.querySelector<HTMLElement>(".md-align-gp")!;
    group.dataset.col = String(spec.col);
    for (const b of group.querySelectorAll("button")) b.classList.toggle("active", b.classList.contains(`md-align-${spec.align}`));
    if (this.dom.isConnected) this.place();
    else setTimeout(() => this.place());
  }

  /** Typora's resizeTableEdit: over the table, 10px wider than it. */
  private place() {
    if (!this.toolbar?.isConnected) return;
    this.toolbar.style.marginTop = `-${this.toolbar.getBoundingClientRect().height}px`;
    this.toolbar.style.width = `${this.dom.getBoundingClientRect().width + 10}px`;
  }

  private run(command: Command) {
    command(this.view.state, this.view.dispatch, this.view);
    this.view.focus();
  }

  private renderToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "ty-table-edit md-table-edit md-tooltip-remove";
    bar.contentEditable = "false";

    const resizeTh = document.createElement("span");
    resizeTh.className = "md-th-button btn-group-xs md-resize-table-th";
    const resize = button("md-resize-table", "Resize Table", "ty-menu");
    resize.addEventListener("click", () => (this.popover ? this.closePopover() : this.openPopover(resizeTh)));
    resizeTh.append(resize);

    const group = document.createElement("span");
    group.className = "btn-group btn-group-xs md-align-gp";
    const alignButton = (to: "left" | "center" | "right", hint: string, iconName: string) => {
      const b = button(`md-align-${to}`, hint, iconName);
      b.addEventListener("click", () => this.run(alignColumn(to)));
      return b;
    };
    group.append(
      alignButton("left", "Align Left", "ty-left-alignment"),
      alignButton("center", "Align Center", "ty-justify-align"),
      alignButton("right", "Align Right", "ty-right-alignment"),
    );

    const deleteTh = document.createElement("span");
    deleteTh.className = "md-th-button right-th-button btn-group-xs";
    const del = button("md-delete-table", "Delete Table", "ty-delete");
    del.addEventListener("click", () => this.run(deleteTable));
    deleteTh.append(del);

    bar.append(resizeTh, group, deleteTh);
    // Buttons act on click; keep the editor's selection (and so the table) meanwhile.
    bar.addEventListener("mousedown", (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    return bar;
  }

  /** Typora's resize popover: a grid to pick the size from, and its size to type in. */
  private openPopover(parent: HTMLElement) {
    const rows = this.node.child(1).childCount + 1;
    const cols = this.node.child(0).child(0).childCount;
    const pop = document.createElement("div");
    pop.className = "popover bottom md-table-resize-popover";
    pop.contentEditable = "false";
    const arrow = document.createElement("div");
    arrow.className = "arrow";
    const wrap = document.createElement("div");
    wrap.className = "md-grid-board-wrap md-reset code-tooltip-content";
    const board = document.createElement("table");
    board.className = "md-grid-board md-reset";
    board.setAttribute("role", "grid");
    const body = document.createElement("tbody");
    const links: HTMLAnchorElement[][] = [];
    const width = document.createElement("input");
    const height = document.createElement("input");
    const ok = document.createElement("button");
    const mark = (w: number, h: number) =>
      links.forEach((r, ri) => r.forEach((a, ci) => a.classList.toggle("md-active", ri < h && ci < w)));
    for (let r = 1; r <= GRID_ROWS; r++) {
      const tr = document.createElement("tr");
      tr.className = "md-reset";
      tr.setAttribute("row", String(r));
      links.push([]);
      for (let c = 1; c <= GRID_COLS; c++) {
        const td = document.createElement("td");
        td.className = "md-reset";
        td.setAttribute("col", String(c));
        if (r <= rows && c <= cols) td.classList.add("md-grid-ext");
        const a = document.createElement("a");
        a.href = "#";
        a.addEventListener("mouseenter", () => {
          mark(c, r);
          width.value = String(c);
          height.value = String(r);
          ok.style.display = "none";
        });
        a.addEventListener("click", (e) => {
          e.preventDefault();
          this.applyResize(c, r);
        });
        td.append(a);
        tr.append(td);
        links[r - 1].push(a);
      }
      body.append(tr);
    }
    board.append(body);
    board.addEventListener("mouseleave", () => {
      mark(0, 0);
      width.value = String(cols);
      height.value = String(rows);
    });

    const title = document.createElement("div");
    title.className = "popover-title";
    width.id = "md-grid-width";
    height.id = "md-grid-height";
    for (const [input, max] of [
      [width, 40],
      [height, 99],
    ] as const) {
      input.type = "text";
      input.size = 2;
      input.addEventListener("focus", () => (ok.style.display = ""));
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          input.value = String(Math.min(max, Math.max(1, (+input.value || 0) + (e.key === "ArrowUp" ? 1 : -1))));
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (input === width) height.focus();
          else ok.click();
        } else if (e.key === "Escape") {
          this.closePopover();
          this.view.focus();
        } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.metaKey && !e.ctrlKey) e.preventDefault();
      });
      input.addEventListener("blur", () => {
        const v = Math.min(max, Math.max(1, +input.value || 2));
        input.value = String(v);
        mark(+width.value, +height.value);
      });
    }
    width.value = String(cols);
    height.value = String(rows);
    ok.id = "md-resize-grid";
    ok.className = "btn btn-primary btn-xs";
    ok.textContent = "OK";
    ok.addEventListener("click", () => this.applyResize(+width.value || cols, +height.value || rows));
    title.append(width, " x ", height, ok);
    wrap.append(board, title);
    pop.append(arrow, wrap);
    parent.append(pop);
    this.popover = pop;
  }

  private closePopover() {
    this.popover?.remove();
    this.popover = null;
  }

  private applyResize(cols: number, rows: number) {
    this.closePopover();
    this.run(resizeTable(cols, rows));
  }

  stopEvent(event: Event) {
    return !!this.toolbar && event.target instanceof Node && this.toolbar.contains(event.target);
  }

  // Only the table's cells are ProseMirror's; the toolbar is this view's own.
  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    if (mutation.type === "selection") return !!this.toolbar?.contains(mutation.target);
    return !this.contentDOM.contains(mutation.target);
  }
}
