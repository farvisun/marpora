import "./styles/base.css";

import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { render } from "solid-js/web";
import { App } from "./chrome/App";
import { countText, docText, outlineOf, setUi, ui } from "./chrome/store";
import { createEditor, runCommand } from "./editor/editor";
import { DocSync } from "./editor/sync";
import { connect, inTauri } from "./ipc";
import { Search, editorTarget, sourceTarget } from "./chrome/search";
import { SourceMode } from "./chrome/source";
import { applyTheme } from "./chrome/theme";
import { exportHtml } from "./export";
import { refreshDiagrams } from "./editor/diagramview";
import { setMathOptions } from "./math";
import { initMarkdown, parseMarkdown, setFlavor } from "./md";

async function main() {
  document.body.classList.add("typora-node", "native-window", "html-for-mac");

  const [backend] = await Promise.all([connect(), initMarkdown()]);
  const [settings, opened] = await Promise.all([backend.settings(), backend.initialDocument()]);
  setFlavor(settings.flavor);
  setMathOptions({ autoNumber: settings.autoNumberMath });
  const showTheme = async (id: string) => {
    setUi("theme", await applyTheme(backend, id));
    refreshDiagrams();
  };
  await showTheme(settings.theme);
  backend.onSettings((s) => {
    if (s.theme !== ui.theme) void showTheme(s.theme);
  });
  const { doc } = parseMarkdown(opened.text);
  setUi("path", opened.path);

  const sync = new DocSync(backend, opened.id, doc, opened.version);
  let view!: EditorView;
  let sourceHost!: HTMLElement;
  const source = new SourceMode(backend, opened.id, sync, () => view, () => sourceHost);
  const search = new Search(() =>
    source.active && source.codeMirror ? sourceTarget(source.codeMirror, () => search.refresh()) : editorTarget(view),
  );
  const toggleSource = async () => {
    setUi("sourceMode", await source.toggle());
    search.retarget();
  };
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = () => {
    refreshTimer = null;
    setUi("outline", outlineOf(view.state.doc));
    setUi("counts", countText(docText(view.state.doc)));
  };

  const mountEditor = (el: HTMLElement) => {
    view = createEditor(el, {
      doc,
      plugins: [sync.plugin()],
      assetUrl: (src) => backend.assetUrl(ui.path, src),
      onChange: (v) => {
        const head = v.state.selection.head;
        setUi("activeHeading", ui.outline.findLastIndex((h) => h.pos <= head));
        if (!refreshTimer) refreshTimer = setTimeout(refresh, 150);
        search.refresh();
      },
    });
  };

  render(
    () => (
      <App
        mountEditor={mountEditor}
        mountSource={(el) => (sourceHost = el)}
        onOutlineClick={(pos) => {
          const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1)));
          view.dispatch(tr);
          (view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: "start", behavior: "smooth" });
          view.focus();
        }}
        onToggleSource={() => void toggleSource()}
        search={search}
      />
    ),
    document.body,
  );
  refresh();
  view.focus();

  backend.onRemotePatch((id, patch) => {
    if (id === opened.id) void sync.applyRemote(patch);
  });

  const save = async (saveAs: boolean) => {
    await source.flush();
    await sync.flush();
    const result = await backend.save(opened.id, saveAs);
    if (result) setUi("path", result.path);
  };

  /** The export page; built from the rendered document, which source mode hides. */
  const page = async (options: { target: string | null; plain?: boolean; print?: boolean }) => {
    const fromSource = source.active;
    if (fromSource) await toggleSource();
    try {
      return await exportHtml(view, { docPath: ui.path, ...options });
    } finally {
      if (fromSource) await toggleSource();
    }
  };

  const exportAs = async (format: "html" | "html-plain" | "pdf") => {
    const pdf = format === "pdf";
    const target = await backend.exportPath(opened.id, pdf ? "PDF" : "HTML", pdf ? "pdf" : "html");
    if (!target) return;
    if (pdf) await backend.exportPdf(target, await page({ target, print: true }));
    else await backend.writeExport(target, await page({ target, plain: format === "html-plain" }));
  };

  const handleMenu = (id: string) => {
    switch (id) {
      case "export-html":
        return void exportAs("html").catch(exportFailed);
      case "export-html-plain":
        return void exportAs("html-plain").catch(exportFailed);
      case "export-pdf":
        return void exportAs("pdf").catch(exportFailed);
      case "print":
        return void page({ target: null, print: true })
          .then((html) => backend.print(html))
          .catch(exportFailed);
      case "save":
        return void save(false);
      case "save-as":
        return void save(true);
      case "toggle-sidebar":
        return setUi("sidebar", !ui.sidebar);
      case "outline":
        setUi("sidebarTab", "outline");
        return setUi("sidebar", true);
      case "focus-mode":
        setUi("focusMode", !ui.focusMode);
        return document.body.classList.toggle("on-focus-mode", ui.focusMode);
      case "typewriter-mode":
        setUi("typewriterMode", !ui.typewriterMode);
        return document.body.classList.toggle("ty-on-typewriter-mode", ui.typewriterMode);
      case "source-mode":
        return void toggleSource();
      case "close":
        return void closeWindow();
      case "find":
        return search.open(false);
      case "replace":
        return search.open(true);
      case "find-next":
        return search.step(1);
      case "find-previous":
        return search.step(-1);
      default:
        if (id.startsWith("theme:")) return void backend.setTheme(id.slice(6));
        // The other export formats go through Pandoc, from the core's text.
        if (id.startsWith("export-")) {
          return void Promise.all([source.flush(), sync.flush()])
            .then(() => backend.exportPandoc(opened.id, id.slice("export-".length)))
            .catch(exportFailed);
        }
        // In source mode, editing commands belong to CodeMirror.
        if (source.active) return source.command(id);
        runCommand(view, id);
    }
  };

  const closeWindow = async () => {
    if (!inTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  };

  if (inTauri) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const win = getCurrentWebviewWindow();
    await win.listen<string>("menu", (e) => handleMenu(e.payload));
    await win.onCloseRequested(async (event) => {
      await source.flush();
      await sync.flush();
      if (!(await backend.isDirty(opened.id))) return;
      const discard = await ask("Your changes will be lost if you don't save them.", {
        title: "Do you want to save the changes?",
        kind: "warning",
        okLabel: "Don't Save",
        cancelLabel: "Cancel",
      });
      if (!discard) event.preventDefault();
    });
  } else {
    // Browser build: no native menu, so the keymap covers editing; add save/sidebar keys.
    window.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        handleMenu(e.shiftKey ? "save-as" : "save");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        handleMenu("toggle-sidebar");
      } else if (mod && e.key === "/") {
        e.preventDefault();
        handleMenu("source-mode");
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        handleMenu(e.altKey ? "replace" : "find");
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        handleMenu(e.shiftKey ? "find-previous" : "find-next");
      } else if (e.key === "F8") handleMenu("focus-mode");
      else if (e.key === "F9") handleMenu("typewriter-mode");
    });
  }

  // Exposed for tests and debugging.
  Object.assign(window, { marpora: { view, sync, source, backend, handleMenu } });
}

/** An export or print that failed: log it and tell the user. */
function exportFailed(e: unknown) {
  report(e);
  if (!inTauri) return;
  const text = e instanceof Error ? e.message : String(e);
  void import("@tauri-apps/plugin-dialog").then(({ message }) =>
    message(text, { title: "Export failed", kind: "error" }),
  );
}

function report(e: unknown) {
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(e);
  if (inTauri) {
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("frontend_log", { message }));
  }
}

window.addEventListener("error", (e) => report(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => report(e.reason));

main().catch((e: unknown) => {
  // A blank window explains nothing; show what went wrong.
  report(e);
  const pre = document.createElement("pre");
  pre.className = "startup-error";
  pre.textContent = `Marpora failed to start:\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  document.body.append(pre);
});
