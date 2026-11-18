import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import HtmlPageViewerPlugin from "../../src/main";
import { App, Plugin, TFile, WorkspaceLeaf } from "./obsidian";

export const VIEW_TYPE = "html-page-viewer";

/** The parts of the plugin's view that Obsidian calls. */
export interface HtmlView {
  file: TFile | null;
  readonly leaf: WorkspaceLeaf;
  readonly contentEl: HTMLElement;
  setViewData(data: string, clear: boolean): void;
  getViewData(): string;
  getDisplayText(): string;
  clear(): void;
  /** Obsidian's file lifecycle, which the view inherits from TextFileView (see obsidian.ts). */
  loadFile(file: TFile | null): Promise<void>;
  onClose(): Promise<void>;
  save(clear?: boolean): Promise<void>;
  requestSave(): void;
  /** Whether Obsidian takes the view for changed and due to be saved. */
  readonly dirty: boolean;
}

/** A loaded plugin in a stand-in Obsidian, with helpers to open views. */
export class Harness {
  readonly app = new App();
  readonly plugin: Plugin;
  private readonly vaultFiles = new Map<string, TFile>();

  private constructor() {
    this.plugin = new HtmlPageViewerPlugin(this.app as never, {} as never) as unknown as Plugin;
  }

  /**
   * Loads the plugin, with the data that a vault saved for it, if any, in an
   * Obsidian with or without the view registry that Obsidian 1.5 and later have.
   */
  static async load(data: unknown = null, { viewRegistry = true } = {}): Promise<Harness> {
    const harness = new Harness();
    harness.plugin.data = data;
    if (!viewRegistry) harness.app.viewRegistry = null;
    await (harness.plugin as unknown as HtmlPageViewerPlugin).onload();
    return harness;
  }

  /**
   * Creates a view as Obsidian does for a new tab, or, given a tab, as it does
   * when the tab returns to an HTML file from another kind of view.
   */
  newView(leaf = new WorkspaceLeaf(this.app)): HtmlView {
    const creator = this.plugin.views.get(VIEW_TYPE);
    assert.ok(creator, "the plugin registers its view");
    const view = creator(leaf) as HtmlView & { onload(): void };
    view.onload();
    return view;
  }

  /** Loads a file into a view as Obsidian does when a file opens in its tab. */
  open(view: HtmlView, path: string, data: string): TFile {
    const file = new TFile(path);
    this.app.files.set(path, data);
    view.file = file;
    view.setViewData(data, true);
    return file;
  }

  /**
   * Opens a file in a view through Obsidian's file lifecycle: the file the view
   * showed unloads, with the save that Obsidian makes then, and the new file is read.
   */
  async openFile(view: HtmlView, path: string, data: string): Promise<TFile> {
    // Obsidian's vault keeps one TFile for each path, so opening a file again
    // gives the view the same object.
    const file = this.vaultFiles.get(path) ?? new TFile(path);
    this.vaultFiles.set(path, file);
    this.app.files.set(path, data);
    await view.loadFile(file);
    return file;
  }
}

export function frame(view: HtmlView): HTMLIFrameElement | null {
  return view.contentEl.querySelector("iframe.html-page-viewer__frame");
}

/**
 * Loads the copy that the view's frame shows, as Chromium loads a frame's
 * `srcdoc` and jsdom does not: once the copy is prepared, the frame's
 * `contentDocument` is a document at about:srcdoc parsed from it, and the
 * frame fires `load`. Only a page with scripts off has Obsidian's origin, so
 * that the view can reach it. `prepare` gets the document before the frame
 * shows it, as to lay it out.
 */
export async function loadFrame(
  view: HtmlView,
  prepare?: (page: Document) => void,
): Promise<Document> {
  await settle();
  const iframe = frame(view);
  assert.ok(iframe?.srcdoc, "the view shows a frame with its copy");
  const page = new JSDOM(iframe.srcdoc, { url: "about:srcdoc" }).window.document;
  prepare?.(page);
  Object.defineProperty(iframe, "contentDocument", { configurable: true, get: () => page });
  iframe.dispatchEvent(new window.Event("load"));
  await settle();
  return page;
}

/**
 * Moves the view's tab to another tab group or window, for its frame, as
 * Chromium does when Obsidian takes the frame out of the page and inserts it
 * again: the frame drops its document, which fires `pagehide`, and loads its
 * copy again (#126). `away` runs from the task after that, while the frame
 * shows no page, and `prepare` gets the next document as `loadFrame` does.
 */
export async function moveFrame(
  view: HtmlView,
  { away, prepare }: { away?: () => void | Promise<void>; prepare?: (page: Document) => void } = {},
): Promise<Document> {
  const win = frame(view)?.contentDocument?.defaultView;
  assert.ok(win, "the frame shows a document");
  win.dispatchEvent(new win.Event("pagehide"));
  await settle();
  await away?.();
  return loadFrame(view, prepare);
}

export function sandboxTokens(iframe: HTMLIFrameElement): string[] {
  const value = iframe.getAttribute("sandbox");
  assert.notEqual(value, null, "the frame has a sandbox attribute");
  return (value ?? "").split(/\s+/).filter(Boolean);
}

export function button(view: HtmlView, label: string | RegExp): HTMLButtonElement {
  const buttons = [...view.contentEl.querySelectorAll("button")];
  const found = buttons.find((candidate) => {
    const name = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
  assert.ok(found, `a button labelled ${String(label)}`);
  return found;
}

export function message(view: HtmlView): string | null {
  return view.contentEl.querySelector(".html-page-viewer__message")?.textContent ?? null;
}

export function securityPill(view: HtmlView): string | null {
  return view.contentEl.querySelector(".html-page-viewer__security-pill")?.textContent ?? null;
}

/** Waits for promises the view started without awaiting them. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
