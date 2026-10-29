// Paragraph › Table › Insert Table (⌥⌘T): Typora's `#table-insert-dialog`, asking for
// the columns and rows (the header row counted) of the table to insert.

import { onMount } from "solid-js";
import { setUi } from "./store";

const LIMITS = { cols: 40, rows: 99 };

export function TableDialog(props: { onInsert(cols: number, rows: number): void }) {
  let cols!: HTMLInputElement;
  let rows!: HTMLInputElement;
  const close = () => setUi("tableDialog", false);
  const ok = () => {
    const n = (input: HTMLInputElement, max: number) => Math.min(max, Math.max(1, Number.parseInt(input.value, 10) || 1));
    close();
    props.onInsert(n(cols, LIMITS.cols), n(rows, LIMITS.rows));
  };
  // Typora's keys: digits only, ↑ and ↓ step, Tab and Enter go on, Escape cancels.
  const keydown = (e: KeyboardEvent, input: HTMLInputElement, max: number, next: () => void) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const value = (Number.parseInt(input.value, 10) || 0) + (e.key === "ArrowUp" ? 1 : -1);
      input.value = String(Math.min(max, Math.max(1, value)));
    } else if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.metaKey && !e.ctrlKey) e.preventDefault();
  };
  onMount(() => requestAnimationFrame(() => cols.select()));
  return (
    <>
      <div class="modal-backdrop in" onMouseDown={close} />
      <div class="modal in" id="table-insert-dialog" role="dialog" style={{ display: "block" }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <div class="modal-title">Insert Table</div>
            </div>
            <div class="modal-body">
              <div class="row">
                <div class="col-lg-6">
                  <div class="input-group">
                    <span class="input-group-addon">Columns</span>
                    <input
                      ref={cols}
                      id="table-insert-col"
                      class="form-control"
                      value="3"
                      onKeyDown={(e) => keydown(e, cols, LIMITS.cols, () => rows.select())}
                    />
                  </div>
                </div>
                <div class="col-lg-6">
                  <div class="input-group">
                    <span class="input-group-addon">Rows</span>
                    <input
                      ref={rows}
                      id="table-insert-row"
                      class="form-control"
                      value="4"
                      onKeyDown={(e) => keydown(e, rows, LIMITS.rows, ok)}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-default" onClick={close}>
                Cancel
              </button>
              <button type="button" class="btn btn-primary" onClick={ok}>
                OK
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
