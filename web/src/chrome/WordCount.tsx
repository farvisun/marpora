// The status bar's word count and its popover (Typora's `#footer-word-count-info`):
// words, characters, lines and reading minutes, those of the selection too, and a
// click on a row picks what the status bar counts, as Typora's delimiter does.

import { For, onCleanup, onMount, Show } from "solid-js";
import { DELIMITER_KEY, setUi, ui } from "./store";

/** Typora's reading speed, in words a minute. */
const WORDS_PER_MINUTE = 382;

/** Typora's delimiters: WORD 0, CHAR 1, LINE 2, TIME 3, each a [plural, singular] label. */
const LABELS = [
  ["Words", "Word"],
  ["Characters", "Character"],
  ["Lines", "Line"],
  ["Minutes", "Minute"],
] as const;

function setDelimiter(d: number) {
  setUi("wordDelimiter", d);
  try {
    localStorage.setItem(DELIMITER_KEY, String(d));
  } catch {
    // Kept for this window only.
  }
}

const minutes = () => Math.round(ui.counts.words / WORDS_PER_MINUTE);

/** The counts the delimiter shows, as [all, in the selection]. */
function shown(d: number): [number, number] {
  const c = ui.counts;
  return [
    [c.words, c.selWords],
    [c.chars, c.selChars],
    [c.lines, 0],
    [minutes(), 0],
  ][d] as [number, number];
}

/** The status bar's label: "12 Words", "3 / 12 Words" with a selection, "≤ 1 Minute". */
export function wordCountLabel(d = ui.wordDelimiter): string {
  const [all, sel] = shown(d);
  const [plural, singular] = LABELS[d];
  if (d === 3 && all === 0) return `≤ 1 ${singular}`;
  if (sel > 0 && sel < all) return `${sel} / ${all} ${plural}`;
  return `${all} ${all === 1 ? singular : plural}`;
}

export function WordCount() {
  let popover: HTMLUListElement | undefined;
  const close = () => setUi("wordCountPopover", false);
  const outside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (ui.wordCountPopover && !popover?.contains(target) && !document.getElementById("footer-word-count")?.contains(target)) close();
  };
  const escape = (e: KeyboardEvent) => ui.wordCountPopover && e.key === "Escape" && close();
  onMount(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", escape, true);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", escape, true);
  });
  const rows = () => [
    { id: "footer-word-count-td", value: ui.counts.words },
    { id: "footer-char-count-td", value: ui.counts.chars },
    { id: "footer-line-count-td", value: ui.counts.lines },
    { id: "footer-read-time-count-td", value: minutes() || "≤ 1" },
  ];
  return (
    <>
      <span
        id="footer-word-count"
        class="footer-item"
        classList={{ active: ui.wordCountPopover }}
        onClick={() => setUi("wordCountPopover", !ui.wordCountPopover)}
      >
        <span id="footer-word-count-label">{wordCountLabel()}</span>
      </span>
      <Show when={ui.wordCountPopover}>
        <ul
          ref={popover}
          id="footer-word-count-info"
          class="dropdown-menu"
          classList={{ "ty-show-word-count-in-selection": ui.counts.selChars > 0 }}
          role="menu"
        >
          <li>
            <table class="ty-footer-word-count-all">
              <tbody>
                <For each={rows()}>
                  {(row, i) => (
                    <tr
                      data-delimiter={i()}
                      onClick={() => {
                        setDelimiter(i());
                        close();
                      }}
                    >
                      <td id={row.id}>{row.value}</td>
                      <td>{LABELS[i()][0]}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </li>
          <li class="divider footer-word-count-selection" />
          <li class="footer-word-count-selection footer-word-count-info-line">
            In Selection: <span id="footer-word-count-td-sel">{ui.counts.selWords}</span> Words,{" "}
            <span id="footer-char-count-td-sel">{ui.counts.selChars}</span> Characters
          </li>
        </ul>
      </Show>
    </>
  );
}
