// What the Preferences window asks of the app (src-tauri commands.rs), with an
// in-memory stand-in for the browser build and tests.

import { inTauri, type Settings } from "../ipc";

export interface ThemeInfo {
  id: string;
  name: string;
  source: "bundled" | "user" | "typora";
}

export interface PrefsApi {
  settings(): Promise<Settings>;
  /** Change some settings; every window hears about it. */
  update(patch: Partial<Settings>): Promise<Settings>;
  onSettings(handler: (settings: Settings) => void): void;
  themes(): Promise<ThemeInfo[]>;
  setTheme(id: string): Promise<void>;
  clearRecent(): Promise<void>;
  openDraftsFolder(): Promise<void>;
  openThemeFolder(): Promise<void>;
  /** Which providers have an API key in the Keychain (keys never come back). */
  aiKeys(): Promise<AiKeys>;
  /** Store `provider`'s API key in the Keychain; an empty key removes it. */
  aiSetKey(provider: keyof AiKeys, key: string): Promise<void>;
}

export interface AiKeys {
  anthropic: boolean;
  openai: boolean;
}

export async function connectPrefs(): Promise<PrefsApi> {
  if (!inTauri) return new MemoryPrefs();
  const { invoke } = await import("@tauri-apps/api/core");
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return {
    settings: () => invoke<Settings>("get_settings"),
    update: (patch) => invoke<Settings>("update_settings", { patch }),
    onSettings: (handler) => {
      void getCurrentWebviewWindow().listen<Settings>("settings", (e) => handler(e.payload));
    },
    themes: () => invoke<ThemeInfo[]>("list_themes"),
    setTheme: (id) => invoke<void>("set_theme", { id }),
    clearRecent: () => invoke<void>("clear_recent"),
    openDraftsFolder: () => invoke<void>("open_drafts_folder"),
    openThemeFolder: () => invoke<void>("open_theme_folder"),
    aiKeys: () => invoke<AiKeys>("ai_keys"),
    aiSetKey: (provider, key) => invoke<void>("ai_set_key", { provider, key }),
  };
}

/** Browser stand-in: settings live in this page; actions are recorded for tests. */
export class MemoryPrefs implements PrefsApi {
  current: Settings = {
    theme: "marpora",
    flavor: { inlineMath: false, highlight: false, subscript: false, superscript: false },
    autoNumberMath: true,
    autoSave: false,
    backupUnsavedDrafts: true,
    recordRecent: true,
    showHiddenFiles: false,
    quitOnLastWindowClosed: false,
    listSort: 0,
    treeSort: 0,
    listNoGroup: false,
    treeNoGroup: false,
    fileSearchCaseSensitive: false,
    fileSearchWholeWord: false,
    fileSearchUseRegexp: false,
    showStatusBar: true,
    imageStorage: "",
    useRelativeImagePath: true,
    insertFinalNewline: false,
    indentFirstLine: false,
    hideBr: false,
    ignoreLineBreak: false,
    exportTheme: "",
    exportPageBreak: false,
    exportAppendHead: "",
    exportAppendBody: "",
    exportImageWidth: 640,
    aiProvider: "anthropic",
    aiModel: "",
    aiBaseUrl: "",
    agentEdits: "apply",
    agentsTrusted: [],
  };
  /** Actions taken, for tests. */
  log: string[] = [];
  private handlers: ((s: Settings) => void)[] = [];

  async settings() {
    return this.current;
  }

  async update(patch: Partial<Settings>) {
    this.current = { ...this.current, ...patch };
    this.log.push("update " + JSON.stringify(patch));
    for (const h of this.handlers) h(this.current);
    return this.current;
  }

  onSettings(handler: (s: Settings) => void) {
    this.handlers.push(handler);
  }

  async themes(): Promise<ThemeInfo[]> {
    return [
      { id: "marpora", name: "Marpora", source: "bundled" },
      { id: "marpora-night", name: "Marpora Night", source: "bundled" },
    ];
  }

  async setTheme(id: string) {
    await this.update({ theme: id });
  }

  async clearRecent() {
    this.log.push("clearRecent");
  }

  async openDraftsFolder() {
    this.log.push("openDraftsFolder");
  }

  async openThemeFolder() {
    this.log.push("openThemeFolder");
  }

  keys: AiKeys = { anthropic: false, openai: false };

  async aiKeys() {
    return { ...this.keys };
  }

  async aiSetKey(provider: keyof AiKeys, key: string) {
    this.keys[provider] = key !== "";
    this.log.push(`aiSetKey ${provider} ${key ? "set" : "removed"}`);
  }
}
