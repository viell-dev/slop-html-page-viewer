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
  readonly leaves: WorkspaceLeaf[] = [];
  activeFile: TFile | null = null;
  readError: Error | null = null;

  readonly vault = {
    getResourcePath: (file: TFile): string => resourcePath(file),
    getAbstractFileByPath: (path: string): TFile | null => (this.files.has(path) ? new TFile(path) : null),
    getRoot: (): null => null,
    cachedRead: async (file: TFile): Promise<string> => this.files.get(file.path) ?? "",
    read: async (file: TFile): Promise<string> => {
      this.reads.push(file.path);
      if (this.readError) throw this.readError;
      return this.files.get(file.path) ?? "";
    },
  };

  readonly listeners = new Map<string, (() => void)[]>();

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

  registerExtensions(extensions: string[], viewType: string): void {
    for (const extension of extensions) this.extensions.set(extension, viewType);
  }

  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
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

  registerEvent(ref: unknown): void {
    this.events.push(ref);
  }
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute("data-icon", icon);
}
