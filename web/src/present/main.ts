// The audience window of View › Present: one slide filling the screen. Keys and clicks
// ask the document's window (the presenter) to move; it answers with what to show.

import { type PresentMessage, presentChannel } from "./channel";
import { mountSlide } from "./slide";

const channel = await presentChannel();
const stage = document.getElementById("stage")!;
const ended = document.getElementById("ended")!;
let deck: { css: string; slides: string[] } = { css: "", slides: [] };
let index = 0;
let black = false;

const show = () => {
  document.body.classList.toggle("black", black);
  void mountSlide(stage, deck.css, black ? undefined : deck.slides[index]);
};

channel.onMessage((m: PresentMessage) => {
  if (m.closed) {
    // The browser stand-in: the show ended without closing this page.
    document.body.classList.add("ended");
    ended.hidden = false;
    return;
  }
  if (m.deck) deck = m.deck;
  if (m.index !== undefined) index = m.index;
  if (m.black !== undefined) black = m.black;
  if (m.deck || m.index !== undefined || m.black !== undefined) show();
});

const KEYS: Record<string, PresentMessage["nav"]> = {
  ArrowRight: "next",
  ArrowDown: "next",
  PageDown: "next",
  " ": "next",
  Enter: "next",
  n: "next",
  ArrowLeft: "prev",
  ArrowUp: "prev",
  PageUp: "prev",
  Backspace: "prev",
  p: "prev",
  Home: "first",
  End: "last",
  b: "black",
  ".": "black",
  Escape: "end",
};

document.addEventListener("keydown", (e) => {
  const nav = KEYS[e.key];
  if (!nav || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  void channel.send({ nav });
});
stage.addEventListener("click", () => void channel.send({ nav: "next" }));
// The pointer hides while it rests.
let idle: ReturnType<typeof setTimeout> | undefined;
document.addEventListener("mousemove", () => {
  document.body.classList.remove("idle");
  clearTimeout(idle);
  idle = setTimeout(() => document.body.classList.add("idle"), 2000);
});

void channel.send({ ready: true });
Object.assign(window, { marporaAudience: { state: () => ({ index, black, slides: deck.slides.length }) } });
