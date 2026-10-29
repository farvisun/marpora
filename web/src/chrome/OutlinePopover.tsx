// View › Toggle Outline Popover: the document's headings in a popover over the page,
// as Typora shows them when the sidebar is closed; a click goes to the heading.

import { For, onCleanup, onMount, Show } from "solid-js";
import { setUi, ui } from "./store";

export function OutlinePopover(props: { onOutlineClick(pos: number): void }) {
  let popover: HTMLUListElement | undefined;
  const close = () => setUi("outlinePopover", false);
  const outside = (e: MouseEvent) => ui.outlinePopover && !popover?.contains(e.target as Node) && close();
  const escape = (e: KeyboardEvent) => ui.outlinePopover && e.key === "Escape" && close();
  onMount(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", escape, true);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", escape, true);
  });
  return (
    <Show when={ui.outlinePopover}>
      <ul ref={popover} id="ty-outline-popover" class="dropdown-menu" role="menu">
        <Show when={ui.outline.length} fallback={<li class="ty-outline-popover-empty">No Headings</li>}>
          <For each={ui.outline}>
            {(item, i) => (
              <li class={`outline-item-wrapper outline-h${item.level}`}>
                <div
                  class="outline-item"
                  classList={{ "outline-item-active": i() === ui.activeHeading }}
                  onClick={() => {
                    close();
                    props.onOutlineClick(item.pos);
                  }}
                >
                  <span class="outline-label">{item.text}</span>
                </div>
              </li>
            )}
          </For>
        </Show>
      </ul>
    </Show>
  );
}
