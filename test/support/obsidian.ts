import "./dom";

// A stand-in for the parts of Obsidian's `obsidian` module that the plugin
// uses. The package only declares types, so the test bundles replace imports
// of `obsidian` with this module (see scripts/test.mjs). Each class records
// what the plugin asked of it, for the tests to inspect.

export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class TFile {
  readonly path: string;
  readonly name: string;
  readonly basename: string;
  readonly extension: string;
  readonly stat: { readonly size: number };

  constructor(path: string, size = 0) {
    this.path = path;
    this.stat = { size };
    this.name = path.slice(path.lastIndexOf("/") + 1);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot === -1 ? this.name : this.name.slice(0, dot);
    this.extension = dot === -1 ? "" : this.name.slice(dot + 1);
  }
}

/** A hotkey registered in a scope. */
export interface ScopeKey {
  readonly modifiers: string[] | null;
  readonly key: string | null;
  readonly func: (event: KeyboardEvent | null) => boolean | void;
}

/** Obsidian's keyboard scopes, which record their hotkeys for tests to press. */
export class Scope {
  readonly keys: ScopeKey[] = [];

  constructor(readonly parent?: Scope) {}

  register(modifiers: string[] | null, key: string | null, func: ScopeKey["func"]): ScopeKey {
    const handler = { modifiers, key, func };
    this.keys.push(handler);
    return handler;
  }

  unregister(handler: ScopeKey): void {
    this.keys.splice(this.keys.indexOf(handler), 1);
  }

  /** Presses a hotkey as Obsidian does while the scope is active, and says whether one handled it. */
  press(modifiers: string[], key: string): boolean {
    const handler = this.keys.find(
      (candidate) => candidate.key === key && JSON.stringify(candidate.modifiers) === JSON.stringify(modifiers),
    );
    if (handler) {
      handler.func(null);
      return true;
    }
    return this.parent?.press(modifiers, key) ?? false;
  }
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
}

export const Platform = { isMacOS: false };

export class WorkspaceLeaf {
  readonly app: App;
  readonly viewStates: ViewState[] = [];
  readonly openedFiles: string[] = [];
  pane: false | string = false;

  constructor(app: App) {
    this.app = app;
  }

  async setViewState(state: ViewState): Promise<void> {
    this.viewStates.push(state);
  }

  async openFile(file: TFile): Promise<void> {
    this.openedFiles.push(file.path);
  }
}

/** The resource URL Obsidian would give a file, with the query it adds. */
export function resourcePath(file: TFile): string {
  return `app://test-vault/${encodeURI(file.path)}?1700000000000`;
}

export class App {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];
  /** The files read as bytes, as the view copies them into a page (#11). */
  readonly binaryReads: string[] = [];
  readonly leaves: WorkspaceLeaf[] = [];
  activeFile: TFile | null = null;
  /** The view that has focus, as `getActiveViewOfType` finds it. */
  activeView: unknown = null;
  readonly scope = new Scope();
  readError: Error | null = null;
  /** Obsidian's settings, as `vault.getConfig` reads them, with Obsidian's defaults. */
  readonly config = new Map<string, unknown>([["readableLineLength", true]]);
  readonly vaultListeners = new Map<string, ((...data: unknown[]) => void)[]>();

  readonly vault = {
    getConfig: (setting: string): unknown => this.config.get(setting),
    on: (name: string, callback: (...data: unknown[]) => void): { name: string } => {
      this.vaultListeners.set(name, [...(this.vaultListeners.get(name) ?? []), callback]);
      return { name };
    },
    /** Fires a vault event, as Obsidian does: `config-changed` after a setting changes. */
    trigger: (name: string, ...data: unknown[]): void => {
      for (const callback of this.vaultListeners.get(name) ?? []) callback(...data);
    },
    getResourcePath: (file: TFile): string => resourcePath(file),
    getAbstractFileByPath: (path: string): TFile | null => {
      const text = this.files.get(path);
      return text === undefined ? null : new TFile(path, new TextEncoder().encode(text).length);
    },
    getRoot: (): null => null,
    cachedRead: async (file: TFile): Promise<string> => this.files.get(file.path) ?? "",
    readBinary: async (file: TFile): Promise<ArrayBuffer> => {
      this.binaryReads.push(file.path);
      return new TextEncoder().encode(this.files.get(file.path) ?? "").buffer as ArrayBuffer;
    },
    read: async (file: TFile): Promise<string> => {
      this.reads.push(file.path);
      if (this.readError) throw this.readError;
      return this.files.get(file.path) ?? "";
    },
  };

  readonly listeners = new Map<string, (() => void)[]>();

  /**
   * Obsidian's view registry, as measured in 1.5.3 and 1.14.4 (#41): it maps
   * extensions to view types as given, without changing case or removing dots,
   * and registering an extension that is already registered throws. Obsidian
   * itself has Markdown's.
   */
  viewRegistry: {
    typeByExtension: Map<string, string>;
    registerExtensions(extensions: string[], viewType: string): void;
    unregisterExtensions(extensions: string[]): void;
    getTypeByExtension(extension: string): string | undefined;
    isExtensionRegistered(extension: string): boolean;
  } | null = {
    typeByExtension: new Map([["md", "markdown"]]),
    registerExtensions(extensions, viewType) {
      for (const extension of extensions) {
        if (this.typeByExtension.has(extension)) {
          throw new Error(`Attempting to register an existing file extension "${extension}"`);
        }
        this.typeByExtension.set(extension, viewType);
      }
    },
    unregisterExtensions(extensions) {
      for (const extension of extensions) this.typeByExtension.delete(extension);
    },
    getTypeByExtension(extension) {
      return this.typeByExtension.get(extension);
    },
    isExtensionRegistered(extension) {
      return this.typeByExtension.has(extension);
    },
  };

  readonly metadataCache = {
    /** Obsidian's link resolution, simplified: an exact path, else the shortest path ending in the link text. */
    getFirstLinkpathDest: (linktext: string): TFile | null => {
      if (this.files.has(linktext)) return new TFile(linktext);
      const matches = [...this.files.keys()].filter((path) => path.endsWith(`/${linktext}`)).sort((a, b) => a.length - b.length);
      return matches.length > 0 ? new TFile(matches[0]) : null;
    },
  };

  readonly workspace = {
    on: (name: string, callback: () => void): { name: string } => {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
      return { name };
    },
    /** Fires a workspace event, as Obsidian does. */
    trigger: (name: string): void => {
      for (const callback of this.listeners.get(name) ?? []) callback();
    },
    getActiveFile: (): TFile | null => this.activeFile,
    getActiveViewOfType: <T>(type: abstract new (...args: never[]) => T): T | null =>
      this.activeView instanceof type ? (this.activeView as T) : null,
    getLeaf: (pane: false | string = false): WorkspaceLeaf => {
      const leaf = new WorkspaceLeaf(this);
      leaf.pane = pane;
      this.leaves.push(leaf);
      return leaf;
    },
  };
}

export interface Command {
  id: string;
  name: string;
  checkCallback?: (checking: boolean) => boolean | void;
}

export class Plugin {
  readonly app: App;
  readonly manifest: unknown;
  readonly views = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
  readonly extensions = new Map<string, string>();
  readonly commands: Command[] = [];

  constructor(app: App, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  registerView(type: string, creator: (leaf: WorkspaceLeaf) => unknown): void {
    this.views.set(type, creator);
  }

  /** As Obsidian does: through the view registry, given back when the plugin unloads. */
  registerExtensions(extensions: string[], viewType: string): void {
    const registry = this.app.viewRegistry;
    if (registry) {
      registry.registerExtensions(extensions, viewType);
      this.register(() => registry.unregisterExtensions(extensions));
      return;
    }
    for (const extension of extensions) {
      if (this.extensions.has(extension)) throw new Error(`Attempting to register an existing file extension "${extension}"`);
      this.extensions.set(extension, viewType);
    }
  }

  private readonly cleanups: (() => void)[] = [];

  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  /** Runs what the plugin registered, as Obsidian does when it unloads the plugin. */
  unload(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }

  /** The data Obsidian keeps for the plugin, in `data.json`; each save is recorded. */
  data: unknown = null;
  readonly saves: unknown[] = [];
  readonly settingTabs: PluginSettingTab[] = [];

  async loadData(): Promise<unknown> {
    return this.data === null ? null : structuredClone(this.data);
  }

  async saveData(data: unknown): Promise<void> {
    this.data = structuredClone(data);
    this.saves.push(this.data);
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }
}

export class PluginSettingTab {
  readonly app: App;
  readonly plugin: Plugin;
  readonly containerEl: HTMLElement = document.createElement("div");

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  display(): void {}
}

/** A toggle, as `Setting.addToggle` hands it out: a checkbox in the setting's element. */
export class ToggleComponent {
  readonly inputEl: HTMLInputElement;

  constructor(parent: HTMLElement) {
    this.inputEl = parent.createEl("input", { attr: { type: "checkbox" } });
  }

  setValue(value: boolean): this {
    this.inputEl.checked = value;
    return this;
  }

  getValue(): boolean {
    return this.inputEl.checked;
  }

  onChange(callback: (value: boolean) => unknown): this {
    this.inputEl.addEventListener("change", () => void callback(this.inputEl.checked));
    return this;
  }
}

/** One setting in a settings tab, rendered as Obsidian's class names describe it. */
export class Setting {
  readonly settingEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly descEl: HTMLElement;
  private readonly controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    const info = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = info.createDiv({ cls: "setting-item-name" });
    this.descEl = info.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }

  addToggle(build: (toggle: ToggleComponent) => unknown): this {
    build(new ToggleComponent(this.controlEl));
    return this;
  }

  addText(build: (text: TextComponent) => unknown): this {
    build(new TextComponent(this.controlEl));
    return this;
  }
}

/** A text field, as `Setting.addText` hands it out. */
export class TextComponent {
  readonly inputEl: HTMLInputElement;

  constructor(parent: HTMLElement) {
    this.inputEl = parent.createEl("input", { attr: { type: "text" } });
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => void callback(this.inputEl.value));
    return this;
  }
}

export class TextFileView {
  readonly app: App;
  readonly leaf: WorkspaceLeaf;
  readonly contentEl: HTMLElement;
  file: TFile | null = null;
  data = "";

  readonly events: unknown[] = [];

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.contentEl = document.createElement("div");
  }

  /** Called by Obsidian when the view is added to the workspace. */
  onload(): void {}

  /** The view's hotkeys while it has focus, which a view assigns itself. */
  scope: Scope | null = null;
  readonly cleanups: (() => void)[] = [];

  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  registerEvent(ref: unknown): void {
    this.events.push(ref);
  }
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute("data-icon", icon);
}
