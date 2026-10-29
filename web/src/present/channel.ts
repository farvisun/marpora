// The line between a deck's document window (presenter) and its audience window
// (src-tauri present.rs relays). In a plain browser, a BroadcastChannel stands in, so
// tests can open both sides as pages.

import { inTauri } from "../ipc";

/** What goes between the two sides of a show. */
export interface PresentMessage {
  /** Presenter → audience: the slides (Marp's CSS and one HTML string a slide). */
  deck?: { css: string; slides: string[] };
  /** Presenter → audience: the slide to show. */
  index?: number;
  /** Presenter → audience: a black screen (B), or not. */
  black?: boolean;
  /** Audience → presenter: a key or click asks to move. */
  nav?: "next" | "prev" | "first" | "last" | "black" | "end";
  /** Audience → presenter: the audience page is up and wants the deck. */
  ready?: boolean;
  /** To the presenter: the audience window closed. */
  closed?: boolean;
}

export interface PresentChannel {
  send(message: PresentMessage): Promise<void>;
  onMessage(handler: (message: PresentMessage) => void): void;
  /** Close the audience window. */
  close(): Promise<void>;
}

const BROWSER_CHANNEL = "marpora-present";

export async function presentChannel(): Promise<PresentChannel> {
  if (!inTauri) {
    const channel = new BroadcastChannel(BROWSER_CHANNEL);
    return {
      send: async (m) => channel.postMessage(m),
      onMessage: (h) => channel.addEventListener("message", (e) => h(e.data as PresentMessage)),
      close: async () => channel.postMessage({ closed: true }),
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return {
    send: (message) => invoke<void>("present_send", { message }),
    onMessage: (h) => void getCurrentWebviewWindow().listen<PresentMessage>("present", (e) => h(e.payload)),
    close: () => invoke<void>("present_close"),
  };
}

/** Open the audience window (the browser build counts the calls, for tests). */
export async function openAudience(): Promise<void> {
  if (!inTauri) {
    (window as { marporaAudienceOpened?: number }).marporaAudienceOpened =
      ((window as { marporaAudienceOpened?: number }).marporaAudienceOpened ?? 0) + 1;
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("present_open");
}
