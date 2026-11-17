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

  constructor(path: string) {
    this.path = path;
    this.name = path.slice(path.lastIndexOf("/") + 1);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot === -1 ? this.name : this.name.slice(0, dot);
    this.extension = dot === -1 ? "" : this.name.slice(dot + 1);
  }
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
}

export class WorkspaceLeaf {
  readonly app: App;
  readonly viewStates: ViewState[] = [];
  view: unknown;

  constructor(app: App) {
    this.app = app;
  }

  async setViewState(state: ViewState): Promise<void> {
    this.viewStates.push(state);
  }
}

/** The resource URL Obsidian would give a file, with the query it adds. */
export function resourcePath(file: TFile): string {
  return `app://test-vault/${encodeURI(file.path)}?1700000000000`;
}

export class App {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];
  /** The files written through `vault.modify`, with what was written. Only Obsidian's own saving calls it. */
  readonly writes: { path: string; data: string }[] = [];
  readonly leaves: WorkspaceLeaf[] = [];
  activeFile: TFile | null = null;
  readError: Error | null = null;
  pluginData: unknown = null;
  readonly pendingPluginSaves = new Set<Promise<void>>();
  maxConcurrentPluginSaves = 0;
  readonly vaultEvents = new Map<string, (file: { path: string }, oldPath: string) => void>();

  readonly vault = {
    on: (event: string, handler: (file: { path: string }, oldPath: string) => void): void => {
      this.vaultEvents.set(event, handler);
    },
    getResourcePath: (file: TFile): string => resourcePath(file),
    read: async (file: TFile): Promise<string> => {
      this.reads.push(file.path);
      if (this.readError) throw this.readError;
      return this.files.get(file.path) ?? "";
    },
    modify: async (file: TFile, data: string): Promise<void> => {
      this.writes.push({ path: file.path, data });
      this.files.set(file.path, data);
    },
  };

  readonly workspace = {
    getActiveFile: (): TFile | null => this.activeFile,
    getLeavesOfType: (): WorkspaceLeaf[] => this.leaves.filter((leaf) => leaf.view !== undefined),
    getLeaf: (): WorkspaceLeaf => {
      const leaf = new WorkspaceLeaf(this);
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

  async loadData(): Promise<unknown> {
    return structuredClone(this.app.pluginData);
  }

  async saveData(data: unknown): Promise<void> {
    const write = new Promise<void>((resolve) => setImmediate(() => {
      this.app.pluginData = structuredClone(data);
      resolve();
    }));
    this.app.pendingPluginSaves.add(write);
    this.app.maxConcurrentPluginSaves = Math.max(
      this.app.maxConcurrentPluginSaves,
      this.app.pendingPluginSaves.size,
    );
    await write;
    this.app.pendingPluginSaves.delete(write);
  }

  registerEvent(): void {}

  registerView(type: string, creator: (leaf: WorkspaceLeaf) => unknown): void {
    this.views.set(type, creator);
  }

  registerExtensions(extensions: string[], viewType: string): void {
    for (const extension of extensions) this.extensions.set(extension, viewType);
  }

  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
}

/**
 * Obsidian's TextFileView, with the file lifecycle that it gives every view
 * that extends it, as Obsidian 1.5.3 and 1.15.1 implement it. It reads a file
 * when the file opens in the view, and saves the view's data to the file
 * through `save`: when another file opens in the view or the view closes, when
 * Obsidian quits, and after `requestSave`. A save writes `getViewData()`
 * whenever it differs from what the view last read from or wrote to the file.
 */
export abstract class TextFileView {
  readonly app: App;
  readonly leaf: WorkspaceLeaf;
  readonly contentEl: HTMLElement;
  file: TFile | null = null;
  data = "";
  /** What the view last read from or wrote to its file; null until a file loads. */
  lastSavedData: string | null = null;
  dirty = false;

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.contentEl = document.createElement("div");
  }

  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;

  /** Asks for a save. Obsidian saves two seconds after the last request; the stand-in saves at once. */
  requestSave = (): void => {
    this.dirty = true;
    void this.save();
  };

  /** Saves the view's data to its file if it changed; given `clear`, then clears the view. */
  async save(clear = false): Promise<void> {
    this.dirty = false;
    const file = this.file;
    if (!file) return;
    const data = this.getViewData();
    if (this.lastSavedData === data || this.lastSavedData === null) return;
    this.data = data;
    this.lastSavedData = data;
    await this.app.vault.modify(file, data);
    if (clear) {
      this.lastSavedData = null;
      this.clear();
    }
  }

  /** Reads the file that opens in the view, and gives the view its contents. */
  async onLoadFile(file: TFile): Promise<void> {
    const data = await this.app.vault.read(file);
    this.lastSavedData = data;
    this.data = data;
    this.setViewData(data, true);
  }

  /** Saves before the view leaves its file. */
  async onUnloadFile(_file: TFile): Promise<void> {
    await this.save(true);
  }

  /**
   * Opens a file in the view, or none, as Obsidian's FileView does when another
   * file opens in the tab or the view closes: the file it showed unloads first.
   */
  async loadFile(file: TFile | null): Promise<void> {
    const previous = this.file;
    if (previous === file) return;
    if (previous) await this.onUnloadFile(previous);
    this.file = null;
    if (file) {
      this.file = file;
      await this.onLoadFile(file);
    }
  }

  /** Closes the view, as when its tab closes or shows another kind of view, such as a note. */
  async onClose(): Promise<void> {
    this.contentEl.empty();
    await this.loadFile(null);
  }
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute("data-icon", icon);
}
