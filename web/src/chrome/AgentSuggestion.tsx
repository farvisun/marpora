// An agent's edit waiting for the user, when Preferences › AI › Agents asks first: the
// lines it changes, and Accept / Reject. The agent's call waits for the answer (see
// src-tauri agent.rs); edits that come while one is shown queue behind it.

import { createSignal, For, onMount, Show } from "solid-js";
import { type AgentSuggestion as Suggestion, type Backend, report } from "../ipc";

/** `text`'s lines, without the empty one after a final newline. */
const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

export function AgentSuggestion(props: { backend: Backend }) {
  const [queue, setQueue] = createSignal<Suggestion[]>([]);
  const current = () => queue()[0];
  const drop = (id: number) => setQueue((q) => q.filter((s) => s.id !== id));

  onMount(() => {
    props.backend.onAgentSuggestion((s) => setQueue((q) => [...q, s]));
    props.backend.onAgentSuggestionDone(drop);
  });

  const answer = (accept: boolean, trust = false) => {
    const s = current();
    if (!s) return;
    drop(s.id);
    void props.backend.agentAnswer(s.id, accept, trust ? s.agent : undefined).catch(report);
  };

  return (
    <Show when={current()}>
      {(s) => (
        <div id="md-agent-suggestion" role="dialog" aria-label="Suggested edit">
          <div class="agent-suggestion-head">
            <span>
              <b>{s().agent || "An agent"}</b> suggests an edit at line {s().line}
            </span>
            <Show when={queue().length > 1}>
              <span class="agent-suggestion-count">{queue().length - 1} more waiting</span>
            </Show>
          </div>
          <pre class="agent-suggestion-diff">
            <For each={lines(s().removed)}>{(l) => <div class="agent-del">{l || " "}</div>}</For>
            <For each={lines(s().added)}>{(l) => <div class="agent-add">{l || " "}</div>}</For>
          </pre>
          <div class="agent-suggestion-actions">
            <Show when={s().agent}>
              <button class="btn btn-link agent-trust" onClick={() => answer(true, true)}>
                Always Allow {s().agent}
              </button>
            </Show>
            <span class="agent-suggestion-spacer" />
            <button class="btn btn-default agent-reject" onClick={() => answer(false)}>
              Reject
            </button>
            <button class="btn btn-primary agent-accept" onClick={() => answer(true)}>
              Accept
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
