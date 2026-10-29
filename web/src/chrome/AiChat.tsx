// AI › AI Chat (⌥⌘J): a panel on the right for talking with the model about the
// document. Each question carries the document as it is now, and the selection when
// there is one; answers can be put in at the cursor or in place of the selection. With
// Folder on, the model may also search and read the other files in the sidebar's folder
// (or the document's), and the chat shows what it looks at.

import { DOMSerializer } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { Backend } from "../ipc";
import { markdownSlice } from "../editor/clipboard";
import { type ChatMessage, chatRequest, cleanAnswer, newRequestId } from "../editor/ai";
import { schema } from "../editor/schema";
import { parseMarkdown } from "../md";
import { setUi, ui } from "./store";

const KEY = "marpora.aiChat";
const FOLDER_KEY = "marpora.aiChatFolder";

/** An answer as formatted text, through the editor's schema (no math or diagrams). */
function rendered(markdown: string): Node {
  try {
    return DOMSerializer.fromSchema(schema).serializeFragment(parseMarkdown(markdown).doc.content);
  } catch {
    return document.createTextNode(markdown);
  }
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savedChat(): ChatMessage[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function AiChat(props: { backend: Backend; view: () => EditorView }) {
  const [messages, setMessages] = createSignal<ChatMessage[]>(savedChat());
  /** The answer streaming in, if any. */
  const [streaming, setStreaming] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [folder, setFolder] = createSignal(stored(FOLDER_KEY) === "1");
  /** What the model is doing in the folder, while it answers. */
  const [tool, setTool] = createSignal("");
  let running = 0;
  let list: HTMLDivElement | undefined;
  let field: HTMLTextAreaElement | undefined;

  const save = (m: ChatMessage[]) => {
    setMessages(m);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(m));
    } catch {
      // The chat is not kept across a reload.
    }
  };
  const scrollDown = () => requestAnimationFrame(() => list && (list.scrollTop = list.scrollHeight));
  const stop = () => {
    if (!running) return;
    void props.backend.aiCancel(running).catch(() => {});
    running = 0;
    // What came so far stays in the chat.
    const partial = streaming();
    if (partial) save([...messages(), { role: "assistant", content: partial }]);
    setStreaming(null);
  };

  const send = () => {
    const question = draft().trim();
    if (!question || running) return;
    const request = chatRequest(props.view().state, messages(), question);
    // Shown as typed; the selection it carried stays in the history for the model.
    const content = request.messages.at(-1)!.content;
    save([...messages(), { role: "user", content, ...(content !== question && { shown: question }) }]);
    setDraft("");
    setError("");
    setStreaming("");
    setTool("");
    const id = (running = newRequestId());
    scrollDown();
    props.backend.aiStart(id, request, folder()).catch((e) => {
      if (id !== running) return;
      running = 0;
      setStreaming(null);
      setError(String(e));
    });
  };

  props.backend.onAi((e) => {
    if (e.id !== running || !running) return;
    if (e.tool) {
      setTool(e.tool);
      scrollDown();
    } else if (e.text) {
      setStreaming((s) => (s ?? "") + e.text);
      scrollDown();
    } else if (e.done !== undefined) {
      running = 0;
      setStreaming(null);
      save([...messages(), { role: "assistant", content: e.done }]);
      scrollDown();
    } else if (e.error) {
      running = 0;
      setStreaming(null);
      setError(e.error);
    }
  });

  /** Put `text` in place of the selection, or at the cursor. */
  const put = (text: string, replace: boolean) => {
    const view = props.view();
    const { from, to } = view.state.selection;
    const at = replace ? from : to;
    view.dispatch(view.state.tr.replace(at, to, markdownSlice(cleanAnswer(text))).scrollIntoView());
    view.focus();
  };

  createEffect(() => {
    document.body.classList.toggle("ai-chat-open", ui.aiChat);
    if (ui.aiChat) requestAnimationFrame(() => field?.focus());
  });
  onCleanup(stop);

  return (
    <Show when={ui.aiChat}>
      <div id="md-ai-chat">
        <div class="md-ai-chat-header">
          <span class="md-ai-chat-title">AI Chat</span>
          <button
            class="md-ai-chat-btn md-ai-chat-folder"
            classList={{ active: folder() }}
            aria-pressed={folder()}
            title="Let the AI search and read the files in this folder"
            onClick={() => {
              setFolder(!folder());
              try {
                localStorage.setItem(FOLDER_KEY, folder() ? "1" : "0");
              } catch {
                // Not remembered across a reload.
              }
            }}
          >
            Folder
          </button>
          <button class="md-ai-chat-btn" title="New Chat" onClick={() => (stop(), save([]), setError(""))}>
            New Chat
          </button>
          <button class="md-ai-chat-btn md-ai-chat-close" title="Close (⌥⌘J)" onClick={() => setUi("aiChat", false)}>
            ×
          </button>
        </div>
        <div class="md-ai-chat-list" ref={list}>
          <Show when={!messages().length && streaming() === null}>
            <div class="md-ai-chat-empty">
              {folder()
                ? "Ask about this document or the other files in its folder, or ask for text to put in it. A selection goes with your question."
                : "Ask about this document, or ask for text to put in it. A selection goes with your question."}
            </div>
          </Show>
          <For each={messages()}>
            {(m) => (
              <div class={`md-ai-chat-msg md-ai-chat-${m.role}`}>
                <Show when={m.role === "assistant"} fallback={<div class="md-ai-chat-text">{m.shown ?? m.content}</div>}>
                  <div class="md-ai-chat-text md-ai-chat-md">{rendered(cleanAnswer(m.content))}</div>
                </Show>
                <Show when={m.role === "assistant"}>
                  <div class="md-ai-chat-actions">
                    <button class="md-ai-chat-btn" onClick={() => put(m.content, false)}>
                      Insert
                    </button>
                    <button class="md-ai-chat-btn" disabled={!ui.counts.selChars} onClick={() => put(m.content, true)}>
                      Replace Selection
                    </button>
                    <button class="md-ai-chat-btn" onClick={() => void props.backend.writeClipboard(cleanAnswer(m.content))}>
                      Copy
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show when={streaming() !== null}>
            <div class="md-ai-chat-msg md-ai-chat-assistant md-ai-chat-streaming">
              <Show when={tool()}>
                <div class="md-ai-chat-tool">{tool()}…</div>
              </Show>
              <div class="md-ai-chat-text">{streaming() || "…"}</div>
            </div>
          </Show>
          <Show when={error()}>
            <div class="md-ai-chat-error">{error()}</div>
          </Show>
        </div>
        <div class="md-ai-chat-input">
          <textarea
            ref={field}
            rows={3}
            placeholder={folder() ? "Ask about this document or folder…" : "Ask about this document…"}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (running) stop();
                else props.view().focus();
              }
            }}
          />
          <Show when={streaming() !== null} fallback={<button class="md-ai-chat-send" disabled={!draft().trim()} onClick={send}>Send</button>}>
            <button class="md-ai-chat-send" onClick={stop}>
              Stop
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
}
