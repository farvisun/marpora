// Blocks changed from outside the editor (an agent, AI, the file on disk) light up
// briefly, so the user sees what moved under them.

import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** Meta on a transaction: `{ from, to }`, the top level range to light up. */
export const highlightKey = new PluginKey<DecorationSet>("remote-highlight");

/** How long the highlight lasts; the CSS animation fades it over the same time. */
const DURATION = 1600;

export function remoteHighlight(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        set = set.map(tr.mapping, tr.doc);
        const range = tr.getMeta(highlightKey) as { from: number; to: number } | "clear" | undefined;
        if (range === "clear") return DecorationSet.empty;
        if (!range) return set;
        const decos: Decoration[] = [];
        tr.doc.nodesBetween(range.from, range.to, (node, pos) => {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "md-remote-edit" }));
          return false;
        });
        return set.add(tr.doc, decos);
      },
    },
    props: { decorations: (state) => highlightKey.getState(state) },
    view: () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        update(view, prev) {
          const set = highlightKey.getState(view.state);
          if (set === highlightKey.getState(prev) || set === DecorationSet.empty) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(highlightKey, "clear").setMeta("addToHistory", false));
          }, DURATION);
        },
        destroy: () => clearTimeout(timer),
      };
    },
  });
}
