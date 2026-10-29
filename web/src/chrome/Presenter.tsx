// View › Present Slides (⌥⌘↩): the presenter view over the document's window while
// the audience window shows the deck full screen (src/present). This side keeps the
// state: the current slide, the black screen and the timer; the audience asks to move.

import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { report } from "../ipc";
import { renderDeck } from "../marp/marp";
import { openAudience, type PresentChannel, type PresentMessage, presentChannel } from "../present/channel";
import { mountSlide } from "../present/slide";
import { setUi, ui } from "./store";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (seconds: number) => `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;

export function Presenter(props: { markdown(): Promise<string> }) {
  const [deck, setDeck] = createSignal<{ css: string; slides: string[]; notes: string[] }>({ css: "", slides: [], notes: [] });
  const [index, setIndex] = createSignal(0);
  const [black, setBlack] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  const [now, setNow] = createSignal(new Date());
  let channel: PresentChannel | undefined;
  let current: HTMLDivElement | undefined;
  let next: HTMLDivElement | undefined;

  const send = (m: PresentMessage) => void channel?.send(m).catch(report);
  const go = (i: number) => {
    const last = deck().slides.length - 1;
    setIndex(Math.max(0, Math.min(last, i)));
    send({ index: index() });
  };
  const end = () => {
    if (!ui.presenting) return;
    setUi("presenting", false);
    void channel?.close().catch(report);
  };
  const navigate = (nav: PresentMessage["nav"]) => {
    if (nav === "next") go(index() + 1);
    else if (nav === "prev") go(index() - 1);
    else if (nav === "first") go(0);
    else if (nav === "last") go(deck().slides.length - 1);
    else if (nav === "black") {
      setBlack(!black());
      send({ black: black() });
    } else if (nav === "end") end();
  };

  const load = async () => {
    const d = await renderDeck(await props.markdown());
    setDeck({ css: d.css, slides: d.slides, notes: d.notes });
    if (index() >= d.slides.length) setIndex(Math.max(0, d.slides.length - 1));
    send({ deck: { css: d.css, slides: d.slides }, index: index(), black: black() });
  };

  onMount(async () => {
    channel = await presentChannel();
    channel.onMessage((m) => {
      if (!ui.presenting) return;
      if (m.closed) {
        setUi("presenting", false);
        return;
      }
      if (m.ready) send({ deck: { css: deck().css, slides: deck().slides }, index: index(), black: black() });
      if (m.nav) navigate(m.nav);
    });
  });

  createEffect(
    on(
      () => ui.presenting,
      (presenting) => {
        document.body.classList.toggle("presenting", presenting);
        if (!presenting) return;
        setIndex(ui.slide);
        setBlack(false);
        setElapsed(0);
        setPaused(false);
        void load()
          .then(openAudience)
          .catch((e) => {
            setUi("presenting", false);
            report(e);
          });
      },
    ),
  );
  // Edits during the show reach the audience.
  createEffect(on(() => ui.docSeq, () => ui.presenting && void load().catch(report), { defer: true }));
  createEffect(() => {
    if (!ui.presenting) return;
    const d = deck();
    const i = index();
    if (current) void mountSlide(current, d.css, d.slides[i]);
    if (next) void mountSlide(next, d.css, d.slides[i + 1]);
  });

  const tick = setInterval(() => {
    setNow(new Date());
    if (ui.presenting && !paused()) setElapsed((s) => s + 1);
  }, 1000);
  onCleanup(() => clearInterval(tick));

  const KEYS: Record<string, PresentMessage["nav"]> = {
    ArrowRight: "next",
    ArrowDown: "next",
    PageDown: "next",
    " ": "next",
    Enter: "next",
    ArrowLeft: "prev",
    ArrowUp: "prev",
    PageUp: "prev",
    Backspace: "prev",
    Home: "first",
    End: "last",
    b: "black",
    ".": "black",
    Escape: "end",
  };
  const keydown = (e: KeyboardEvent) => {
    if (!ui.presenting || e.metaKey || e.ctrlKey || e.altKey) return;
    const nav = KEYS[e.key];
    if (!nav) return;
    e.preventDefault();
    e.stopPropagation();
    navigate(nav);
  };
  onMount(() => document.addEventListener("keydown", keydown, true));
  onCleanup(() => document.removeEventListener("keydown", keydown, true));

  return (
    <Show when={ui.presenting}>
      <div id="marp-presenter">
        <div class="presenter-bar">
          <span class="presenter-count">
            {deck().slides.length ? `${index() + 1} / ${deck().slides.length}` : ""}
          </span>
          <span class="presenter-timer" classList={{ paused: paused() }}>
            {clock(elapsed())}
          </span>
          <button class="presenter-btn" onClick={() => setPaused(!paused())}>
            {paused() ? "Resume" : "Pause"}
          </button>
          <button class="presenter-btn" onClick={() => setElapsed(0)}>
            Reset
          </button>
          <span class="presenter-clock">{now().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="presenter-spacer" />
          <button class="presenter-btn" title="Previous (←)" onClick={() => navigate("prev")}>
            ‹ Previous
          </button>
          <button class="presenter-btn" title="Next (→)" onClick={() => navigate("next")}>
            Next ›
          </button>
          <button class="presenter-btn" classList={{ active: black() }} title="Black Screen (B)" onClick={() => navigate("black")}>
            Black
          </button>
          <button class="presenter-btn presenter-end" title="End (Esc)" onClick={end}>
            End Show
          </button>
        </div>
        <div class="presenter-main">
          <div class="presenter-current" ref={current} />
          <div class="presenter-side">
            <div class="presenter-label">Next</div>
            <div class="presenter-next" ref={next} />
            <div class="presenter-label">Notes</div>
            <div class="presenter-notes">{deck().notes[index()] || "No notes for this slide."}</div>
          </div>
        </div>
      </div>
    </Show>
  );
}
