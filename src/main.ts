import {
  Notice,
  Platform,
  Plugin,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { preparePage, styleElementText, withoutQuery } from "./document";
import { type PaneChoice, watchLinks } from "./links";
import { READING_STYLE_ID, readingStylesheet, readTheme } from "./reading";
import { DEFAULT_SETTINGS, readSettings, type SettingsHost, type ViewerSettings, ViewerSettingTab } from "./settings";

const VIEW_TYPE_HTML_PAGE_VIEWER = "html-page-viewer";
const HTML_EXTENSIONS = ["html", "htm"];

type ViewMode = "rendered" | "source";

/** The toolbar choices that a tab keeps from one file to the next. */
interface TabChoices {
  readonly mode: ViewMode;
  readonly theme: boolean;
}

export default class HtmlPageViewerPlugin extends Plugin implements SettingsHost {
  settings: ViewerSettings = DEFAULT_SETTINGS;

  /**
   * Each tab's choices, kept while the tab shows other views, such as a note:
   * Obsidian then replaces this plugin's view, but keeps the tab.
   */
  readonly tabChoices = new WeakMap<WorkspaceLeaf, TabChoices>();

  async onload(): Promise<void> {
    this.settings = readSettings(await this.loadData());
    this.registerView(
      VIEW_TYPE_HTML_PAGE_VIEWER,
      (leaf) => new HtmlPageViewerView(leaf, this),
    );
    this.registerExtensions(HTML_EXTENSIONS, VIEW_TYPE_HTML_PAGE_VIEWER);
    this.addSettingTab(new ViewerSettingTab(this.app, this));

    this.addCommand({
      id: "open-current-html-in-viewer",
      name: "Open current HTML file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isHtmlFile(file)) return false;

        if (!checking) {
          void this.openHtmlFile(file);
        }
        return true;
      },
    });
  }

  async openHtmlFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_HTML_PAGE_VIEWER,
      state: { file: file.path },
      active: true,
    });
  }

  /** Changes and saves settings. Open tabs keep what they show; the change applies to what opens next. */
  async updateSettings(change: Partial<ViewerSettings>): Promise<void> {
    this.settings = { ...this.settings, ...change };
    await this.saveData(this.settings);
  }
}

class HtmlPageViewerView extends TextFileView {
  private mode: ViewMode;
  private scriptsEnabled: boolean;
  private themeEnabled: boolean;
  private iframe: HTMLIFrameElement | null = null;
  private themeButton: HTMLButtonElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: HtmlPageViewerPlugin,
  ) {
    super(leaf);
    // A tab's own choices come first; scripts are not among them, but start
    // as the settings say for every file.
    const choices = plugin.tabChoices.get(leaf);
    this.mode = choices?.mode ?? "rendered";
    this.themeEnabled = choices?.theme ?? plugin.settings.themeOn;
    this.scriptsEnabled = plugin.settings.scriptsOn;
  }

  /** Keeps the tab's choices for the next view in it. */
  private rememberChoices(): void {
    this.plugin.tabChoices.set(this.leaf, { mode: this.mode, theme: this.themeEnabled });
  }

  getViewType(): string {
    return VIEW_TYPE_HTML_PAGE_VIEWER;
  }

  onload(): void {
    super.onload();
    this.registerEvent(this.app.workspace.on("css-change", () => this.updateTheme()));
  }

  getDisplayText(): string {
    return this.file?.basename ?? "HTML page viewer";
  }

  getIcon(): string {
    return "file-code-2";
  }

  setViewData(data: string, clear: boolean): void {
    // Obsidian sets `clear` when a different file opens in this view, which
    // must start with scripts as the settings say, like a new tab.
    if (clear) this.clear();
    this.data = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = "";
    this.scriptsEnabled = this.plugin.settings.scriptsOn;
    this.iframe = null;
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("html-page-viewer");

    const header = container.createDiv({ cls: "html-page-viewer__header" });
    this.renderTitle(header);
    this.renderToolbar(header);

    if (!this.file) {
      renderMessage(container, "No HTML file is attached to this viewer.");
      return;
    }

    if (!isHtmlFile(this.file)) {
      renderMessage(container, "This viewer only supports .html and .htm files.");
      return;
    }

    if (!this.data.trim()) {
      renderMessage(container, "This HTML file is empty.");
      return;
    }

    const security = container.createDiv({ cls: "html-page-viewer__security" });
    security.createSpan({
      cls: "html-page-viewer__security-pill",
      text: this.scriptsEnabled ? "Scripts ON" : "Scripts OFF",
    });
    security.createSpan({
      text: this.scriptsEnabled
        ? "Sandbox allows scripts, isolated from Obsidian and from this vault's files; forms, popups, and top navigation remain blocked."
        : "Sandbox blocks scripts, forms, popups, and top navigation; the page can show files from this vault.",
    });

    if (this.mode === "source") {
      renderSource(container, this.data);
      return;
    }

    this.renderIframe(container);
  }

  private renderTitle(parent: HTMLElement): void {
    const title = parent.createDiv({ cls: "html-page-viewer__title" });
    title.createDiv({
      cls: "html-page-viewer__filename",
      text: this.file?.name ?? "HTML file",
    });
    title.createDiv({
      cls: "html-page-viewer__path",
      text: this.file?.path ?? "",
    });
  }

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "html-page-viewer__toolbar" });
    const modeGroup = toolbar.createDiv({
      cls: "html-page-viewer__segmented",
      attr: { "aria-label": "View mode" },
    });
    const renderedButton = createTextButton(modeGroup, "Rendered");
    const sourceButton = createTextButton(modeGroup, "Source");
    renderedButton.toggleClass("is-active", this.mode === "rendered");
    sourceButton.toggleClass("is-active", this.mode === "source");

    renderedButton.addEventListener("click", () => {
      this.mode = "rendered";
      this.rememberChoices();
      this.render();
    });
    sourceButton.addEventListener("click", () => {
      this.mode = "source";
      this.rememberChoices();
      this.render();
    });

    const refreshButton = createIconButton(toolbar, "refresh-cw", "Refresh preview");
    refreshButton.addEventListener("click", () => {
      void this.reloadFile();
    });

    const scriptsButton = createTextButton(toolbar, this.scriptsEnabled ? "Scripts ON" : "Scripts OFF");
    scriptsButton.addClass("html-page-viewer__scripts-toggle");
    scriptsButton.toggleClass("is-enabled", this.scriptsEnabled);
    scriptsButton.setAttribute("aria-pressed", String(this.scriptsEnabled));
    scriptsButton.setAttribute("title", "Toggle JavaScript for this viewer tab");
    scriptsButton.addEventListener("click", () => {
      this.scriptsEnabled = !this.scriptsEnabled;
      this.render();
    });

    const themeButton = createTextButton(toolbar, this.themeEnabled ? "Theme ON" : "Theme OFF");
    themeButton.addClass("html-page-viewer__theme-toggle");
    themeButton.toggleClass("is-enabled", this.themeEnabled);
    themeButton.setAttribute("aria-pressed", String(this.themeEnabled));
    themeButton.setAttribute("title", "Show pages without styles of their own in Obsidian's theme");
    themeButton.addEventListener("click", () => {
      this.themeEnabled = !this.themeEnabled;
      this.rememberChoices();
      this.render();
    });
    this.themeButton = themeButton;
  }

  /** Follows a change of Obsidian's theme in the page, in place where possible. */
  private updateTheme(): void {
    const iframe = this.iframe;
    if (!iframe || !this.themeEnabled) return;
    const style = iframe.contentDocument?.getElementById(READING_STYLE_ID);
    if (style) {
      style.textContent = styleElementText(readingStylesheet(readTheme(this.contentEl.ownerDocument)));
    } else if (this.scriptsEnabled) {
      // With scripts on, the page has an opaque origin, so prepare it again.
      this.render();
    }
  }

  private renderIframe(parent: HTMLElement): void {
    const file = this.file;
    if (!file) {
      renderMessage(parent, "No HTML file is attached to this viewer.");
      return;
    }

    const frameWrap = parent.createDiv({ cls: "html-page-viewer__frame-wrap" });
    const iframe = frameWrap.createEl("iframe", {
      cls: "html-page-viewer__frame",
      attr: {
        title: file.name,
        referrerpolicy: "no-referrer",
      },
    });
    iframe.setAttribute("sandbox", sandboxValue(this.scriptsEnabled));
    this.iframe = iframe;
    void this.loadPage(file, this.data, iframe);
  }

  /**
   * Shows a copy of the page in the frame, prepared so that its references to
   * vault files load (see document.ts). The frame shows the file as it is if
   * preparing the copy fails, and nothing if the view moved on meanwhile.
   */
  private async loadPage(file: TFile, data: string, iframe: HTMLIFrameElement): Promise<void> {
    const pageUrl = withoutQuery(this.app.vault.getResourcePath(file));
    const depth = file.path.split("/").length - 1;
    const vaultUrl = new URL("../".repeat(depth) || "./", pageUrl).href;
    const readingStyle = this.themeEnabled
      ? readingStylesheet(readTheme(this.contentEl.ownerDocument))
      : undefined;
    let page: string;
    let ownStyles = false;
    try {
      const prepared = await preparePage(
        data,
        {
          pageUrl,
          vaultUrl,
          read: (path) => this.readVaultText(path),
          exists: (path) => this.app.vault.getAbstractFileByPath(path) !== null,
          locate: (linktext) => this.app.metadataCache.getFirstLinkpathDest(linktext, file.path)?.path ?? null,
        },
        { readingStyle },
      );
      page = prepared.html;
      ownStyles = prepared.ownStyles;
    } catch (error) {
      console.error("HTML Page Viewer: could not prepare the page", error);
      page = data;
    }
    if (this.iframe !== iframe) return;
    const watched = new WeakSet<Document>();
    const watch = (): boolean => {
      // Only a page with Obsidian's origin (scripts off) can be reached.
      const doc = iframe.contentDocument;
      if (!doc || doc.URL !== "about:srcdoc") return false;
      if (!watched.has(doc)) {
        watched.add(doc);
        watchLinks(doc, pageUrl, vaultUrl, Platform.isMacOS, {
          openVault: (path, pane, reference) => void this.openVaultPath(path, pane, reference, file.path),
          openExternal: (url) => window.open(url),
          refuse: () => new Notice("This link leads outside the vault, so it was not opened."),
        });
      }
      return true;
    };
    iframe.addEventListener("load", watch);
    iframe.srcdoc = page;
    if (ownStyles && this.themeButton) {
      this.themeButton.disabled = true;
      this.themeButton.setAttribute("title", "This page has styles of its own");
    }

    // The page's document exists long before its images have loaded and the
    // frame fires load, so watch its links as soon as it does.
    if (!(iframe.getAttribute("sandbox") ?? "").includes("allow-same-origin")) return;
    // A timer, not requestAnimationFrame, which pauses in windows that are not
    // painted. Without animation frames the window renders nothing, as in the
    // unit tests' jsdom, and only the load event remains.
    const win = iframe.ownerDocument.defaultView;
    if (!win?.requestAnimationFrame) return;
    const started = Date.now();
    const poll = (): void => {
      if (watch() || !iframe.isConnected || Date.now() - started > 10_000) return;
      win.setTimeout(poll, 15);
    };
    poll();
  }

  /**
   * Opens a vault file a link leads to; a folder opens its index page. A link
   * whose path leads nowhere opens the file Obsidian's link resolution finds
   * for it from this page, by name or by a partial path.
   */
  private async openVaultPath(path: string, pane: PaneChoice, reference: string, pagePath: string): Promise<void> {
    const vault = this.app.vault;
    const clean = path.replace(/\/+$/, "");
    let target = clean === "" ? vault.getRoot() : vault.getAbstractFileByPath(clean);
    if (target !== null && !(target instanceof TFile)) {
      const folder = clean === "" ? "" : `${clean}/`;
      target = vault.getAbstractFileByPath(`${folder}index.html`) ?? vault.getAbstractFileByPath(`${folder}index.htm`);
    } else if (target === null) {
      let linktext = "";
      try {
        linktext = decodeURIComponent(withoutQuery(reference)).replace(/^\/+/, "");
      } catch {
        // A malformed reference names nothing.
      }
      target = linktext === "" ? null : this.app.metadataCache.getFirstLinkpathDest(linktext, pagePath);
    }
    if (target instanceof TFile) {
      await this.app.workspace.getLeaf(pane).openFile(target);
    } else {
      new Notice(`There is no file at "${path}" in this vault.`);
    }
  }

  private async readVaultText(path: string): Promise<string | null> {
    const target = this.app.vault.getAbstractFileByPath(path);
    return target instanceof TFile ? this.app.vault.cachedRead(target) : null;
  }

  private async reloadFile(): Promise<void> {
    if (!this.file) {
      new Notice("No HTML file to refresh");
      return;
    }

    try {
      this.data = await this.app.vault.read(this.file);
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.addClass("html-page-viewer");
      renderMessage(this.contentEl, `Unable to read HTML file: ${getErrorMessage(error)}`);
    }
  }
}

/**
 * The frame's sandbox. With scripts off, the page keeps Obsidian's origin so
 * that it can load the vault's files; with scripts on, it gets an opaque origin
 * instead. Scripts and same-origin access are never granted together, because
 * a page with both could reach Obsidian and the vault through scripts.
 */
export function sandboxValue(scriptsEnabled: boolean): string {
  return scriptsEnabled ? "allow-scripts" : "allow-same-origin";
}

function renderSource(parent: HTMLElement, data: string): void {
  const source = parent.createDiv({ cls: "html-page-viewer__source" });
  const pre = source.createEl("pre");
  data.split("\n").forEach((line, index) => {
    const lineEl = pre.createDiv({ cls: "html-page-viewer__source-line" });
    lineEl.createSpan({ cls: "html-page-viewer__line-number", text: String(index + 1) });
    const code = lineEl.createSpan({ cls: "html-page-viewer__source-code" });
    highlightHtmlLine(code, line);
  });
}

function highlightHtmlLine(parent: HTMLElement, line: string): void {
  let cursor = 0;

  while (cursor < line.length) {
    const commentStart = line.indexOf("<!--", cursor);
    const tagStart = line.indexOf("<", cursor);
    const nextStart = nextTokenStart(commentStart, tagStart);

    if (nextStart === -1) {
      parent.appendText(line.slice(cursor));
      return;
    }

    if (nextStart > cursor) {
      parent.appendText(line.slice(cursor, nextStart));
    }

    if (nextStart === commentStart) {
      const commentEnd = line.indexOf("-->", commentStart + 4);
      const end = commentEnd === -1 ? line.length : commentEnd + 3;
      parent.createSpan({
        cls: "html-page-viewer__tok-comment",
        text: line.slice(commentStart, end),
      });
      cursor = end;
      continue;
    }

    const tagEnd = line.indexOf(">", tagStart + 1);
    const end = tagEnd === -1 ? line.length : tagEnd + 1;
    highlightTag(parent, line.slice(tagStart, end));
    cursor = end;
  }
}

function nextTokenStart(commentStart: number, tagStart: number): number {
  if (commentStart === -1) return tagStart;
  if (tagStart === -1) return commentStart;
  return Math.min(commentStart, tagStart);
}

function highlightTag(parent: HTMLElement, tag: string): void {
  let cursor = 0;
  const tagName = tag.match(/^<\s*\/?\s*([A-Za-z][A-Za-z0-9:._-]*)/);

  if (!tagName) {
    parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag });
    return;
  }

  const matchIndex = tagName.index ?? 0;
  const nameStart = matchIndex + tagName[0].lastIndexOf(tagName[1]);
  const nameEnd = nameStart + tagName[1].length;
  parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag.slice(0, nameStart) });
  parent.createSpan({ cls: "html-page-viewer__tok-tag", text: tag.slice(nameStart, nameEnd) });
  cursor = nameEnd;

  while (cursor < tag.length) {
    const attr = nextAttributeToken(tag, cursor);
    if (!attr) {
      parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag.slice(cursor) });
      return;
    }

    if (attr.start > cursor) {
      parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: tag.slice(cursor, attr.start) });
    }
    parent.createSpan({ cls: "html-page-viewer__tok-attr", text: attr.name });
    if (attr.value) {
      parent.createSpan({ cls: "html-page-viewer__tok-punctuation", text: attr.separator });
      parent.createSpan({ cls: "html-page-viewer__tok-string", text: attr.value });
    }
    cursor = attr.end;
  }
}

function nextAttributeToken(
  tag: string,
  start: number,
): { start: number; end: number; name: string; separator: string; value: string } | null {
  let cursor = start;
  while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
  if (cursor >= tag.length || tag[cursor] === ">" || tag[cursor] === "/") return null;

  const nameStart = cursor;
  while (cursor < tag.length && isAttributeNameChar(tag[cursor])) cursor += 1;
  if (cursor === nameStart) return null;

  const name = tag.slice(nameStart, cursor);
  let separator = "";
  let value = "";

  while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
  if (tag[cursor] === "=") {
    const separatorStart = cursor;
    cursor += 1;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
    separator = tag.slice(separatorStart, cursor);

    if (tag[cursor] === "\"" || tag[cursor] === "'") {
      const quote = tag[cursor];
      const valueStart = cursor;
      cursor += 1;
      while (cursor < tag.length && tag[cursor] !== quote) cursor += 1;
      if (cursor < tag.length) cursor += 1;
      value = tag.slice(valueStart, cursor);
    } else {
      const valueStart = cursor;
      while (cursor < tag.length && !/\s|>/.test(tag[cursor])) cursor += 1;
      value = tag.slice(valueStart, cursor);
    }
  }

  return { start: nameStart, end: cursor, name, separator, value };
}

function isAttributeNameChar(char: string): boolean {
  return /[A-Za-z0-9:._-]/.test(char);
}

function createIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "clickable-icon html-page-viewer__button",
    attr: { "aria-label": label, title: label, type: "button" },
  });
  setIcon(button, icon);
  return button;
}

function createTextButton(parent: HTMLElement, label: string): HTMLButtonElement {
  return parent.createEl("button", {
    cls: "html-page-viewer__text-button",
    text: label,
    attr: { type: "button" },
  });
}

function renderMessage(parent: HTMLElement, message: string): void {
  parent.createDiv({ cls: "html-page-viewer__message", text: message });
}

function isHtmlFile(file: TFile | null): file is TFile {
  return Boolean(file && HTML_EXTENSIONS.includes(file.extension.toLowerCase()));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
