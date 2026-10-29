// AI › Ask AI… (⇧⌘J): a prompt under the selection that asks the model to rewrite it, or
// to write at the cursor. The answer streams into a preview; Enter puts it in place of
// the selection (one undo step), Escape throws it away.

import type { EditorView } from "prosemirror-view";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { Backend } from "../ipc";
import { markdownSlice } from "../editor/clipboard";
import { aiRequest, aiTargetOf, cleanAnswer, PRESETS, setAiTarget, type Target } from "../editor/ai";
import { parseMarkdown } from "../md";
import { setUi, ui } from "./store";

let nextId = 1;

type Phase = "prompt" | "streaming" | "done" | "error";

export function InlineAi(props: { backend: Backend; view: () => EditorView }) {
  const [phase, setPhase] = createSignal<Phase>("prompt");
  const [input, setInput] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const [error, setError] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [place, setPlace] = createSignal({ top: 0, left: 0 });
  /** The target is a selection, not a cursor. */
  const [selected, setSelected] = createSignal(false);
  let box: HTMLDivElement | undefined;
  let field: HTMLInputElement | undefined;
  let running = 0;
  let asked = "";

  const presets = () => {
    const q = input().trim().toLowerCase();
    return PRESETS.filter((p) => (selected() ? p.id !== "continue" : p.id === "continue" || p.id === "translate")).filter(
      (p) => !q || p.label.toLowerCase().includes(q),
    );
  };

  const stop = () => {
    if (running) void props.backend.aiCancel(running).catch(() => {});
    running = 0;
  };
  const close = () => {
    stop();
    const view = props.view();
    setAiTarget(view, null);
    setUi("inlineAi", null);
    view.focus();
  };

  const run = (instruction: string) => {
    const view = props.view();
    const target = aiTargetOf(view.state);
    if (!target || !instruction.trim()) return;
    stop();
    asked = instruction;
    running = nextId++;
    setAnswer("");
    setError("");
    setPhase("streaming");
    const id = running;
    props.backend.aiStart(id, aiRequest(view.state, target, instruction)).catch((e) => {
      if (id !== running) return;
      running = 0;
      setError(String(e));
      setPhase("error");
    });
  };

  const choose = (index: number) => {
    const preset = presets()[index];
    if (!preset) return run(input());
    // Translate asks for the language first.
    if (preset.id === "translate" && !input().toLowerCase().startsWith("translate")) {
      setInput(preset.instruction);
      field?.focus();
      return;
    }
    run(preset.instruction);
  };

  /** Put the answer in for the target, or below the block it ends in. */
  const accept = (below = false) => {
    const view = props.view();
    const target = aiTargetOf(view.state);
    const text = cleanAnswer(answer());
    if (!target || !text) return close();
    const tr = view.state.tr;
    if (below) {
      const $to = view.state.doc.resolve(target.to);
      const at = $to.depth ? $to.after(1) : target.to;
      tr.insert(at, parseMarkdown(text).doc.content);
    } else tr.replace(target.from, target.to, markdownSlice(text));
    view.dispatch(tr.scrollIntoView());
    close();
  };

  props.backend.onAi((e) => {
    if (e.id !== running) return;
    if (e.text) setAnswer((a) => a + e.text);
    else if (e.done !== undefined) {
      running = 0;
      setAnswer(e.done);
      setPhase("done");
    } else if (e.error) {
      running = 0;
      setError(e.error);
      setPhase("error");
    }
  });

  /** Under the target, or above it when there is no room below. */
  const position = (target: Target) => {
    const view = props.view();
    const start = view.coordsAtPos(target.from);
    const end = view.coordsAtPos(target.to);
    const width = Math.min(520, window.innerWidth - 16);
    const left = Math.max(8, Math.min(start.left, window.innerWidth - width - 8));
    const height = box?.offsetHeight ?? 200;
    const top = end.bottom + 6 + height < window.innerHeight ? end.bottom + 6 : Math.max(8, start.top - height - 6);
    setPlace({ top, left });
  };

  createEffect(
    on(
      () => ui.inlineAi?.seq,
      () => {
        const open = ui.inlineAi;
        if (!open) return;
        const view = props.view();
        const { from, to } = view.state.selection;
        stop();
        setAiTarget(view, { from, to });
        setSelected(from < to);
        setInput(open.instruction);
        setAnswer("");
        setActive(0);
        setPhase("prompt");
        // At once, so that typing goes to the prompt and not the editor.
        field?.focus();
        requestAnimationFrame(() => {
          position({ from, to });
          if (open.run) choose(Math.max(0, presets().findIndex((p) => p.instruction === open.instruction)));
        });
      },
    ),
  );

  const keydown = (e: KeyboardEvent) => {
    if (!ui.inlineAi) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (phase() === "streaming") {
        stop();
        setPhase(answer() ? "done" : "prompt");
      } else close();
      return;
    }
    if (phase() === "done" && (e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
      e.preventDefault();
      accept(e.key === "Enter" && e.altKey);
      return;
    }
    if (phase() !== "prompt") return;
    const n = presets().length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      // Typed text that is not a preset's name is the instruction.
      const typed = input().trim();
      if (typed && !presets().some((p) => p.label.toLowerCase() === typed.toLowerCase())) run(typed);
      else choose(active());
    }
  };
  const outside = (e: MouseEvent) => ui.inlineAi && box && !box.contains(e.target as Node) && close();
  onMount(() => {
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("mousedown", outside, true);
  });
  onCleanup(() => {
    stop();
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("mousedown", outside, true);
  });

  return (
    <Show when={ui.inlineAi}>
      <div ref={box} id="md-ai-inline" style={{ top: `${place().top}px`, left: `${place().left}px` }}>
        <div class="md-ai-input">
          <input
            ref={(el) => {
              field = el;
              queueMicrotask(() => el.focus());
            }}
            placeholder="Ask AI to edit or write…"
            value={input()}
            readOnly={phase() === "streaming"}
            onInput={(e) => {
              setInput(e.currentTarget.value);
              setActive(0);
              if (phase() !== "prompt") setPhase("prompt");
            }}
          />
          <Show when={phase() === "streaming"}>
            <button class="md-ai-stop" title="Stop (Esc)" onClick={() => (stop(), setPhase(answer() ? "done" : "prompt"))}>
              Stop
            </button>
          </Show>
        </div>
        <Show when={phase() === "prompt" && presets().length}>
          <ul class="md-ai-presets">
            <For each={presets()}>
              {(p, i) => (
                <li
                  classList={{ active: i() === active() }}
                  onMouseEnter={() => setActive(i())}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i())}
                >
                  {p.label}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={phase() === "streaming" || phase() === "done"}>
          <div class="md-ai-preview">{cleanAnswer(answer()) || "…"}</div>
        </Show>
        <Show when={phase() === "error"}>
          <div class="md-ai-error">{error()}</div>
        </Show>
        <Show when={phase() === "done" || phase() === "error"}>
          <div class="md-ai-actions">
            <Show when={phase() === "done"}>
              <button class="btn btn-primary" onClick={() => accept()}>
                {selected() ? "Replace" : "Insert"}
                <kbd>↵</kbd>
              </button>
              <button class="btn btn-default" onClick={() => accept(true)}>
                Insert Below<kbd>⌥↵</kbd>
              </button>
            </Show>
            <button class="btn btn-default" onClick={() => run(asked)}>
              Try Again
            </button>
            <button class="btn btn-default" onClick={close}>
              Discard<kbd>esc</kbd>
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
