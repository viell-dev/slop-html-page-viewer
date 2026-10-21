import {
  type Events,
  Notice,
  Platform,
  Plugin,
  Scope,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { type LocalFiles, preparePage, styleElementText, withoutQuery } from "./document";
import { FIND_STYLE, FIND_STYLE_ID, findRanges, Highlighter, pageRuns, sourceRuns, type TextRun } from "./find";
import { type PaneChoice, watchLinks } from "./links";
import { ExtensionRegistration, extensionRegistry } from "./extensions";
import { READING_STYLE_ID, readingStylesheet, readTheme } from "./reading";
import { DEFAULT_SETTINGS, readSettings, type SettingsHost, type ViewerSettings, ViewerSettingTab } from "./settings";

const VIEW_TYPE_HTML_PAGE_VIEWER = "html-page-viewer";
/** The workspace event that tells open views the settings changed. */
const SETTINGS_CHANGE = "html-page-viewer:settings-change";

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

  /** The extensions the viewer holds in Obsidian's view registry, which follow the settings. */
  private registration: ExtensionRegistration | null = null;
  /** Without the registry: the extensions registered once, and those another view had. */
  private fixedExtensions = { held: [] as string[], refused: [] as string[] };

  async onload(): Promise<void> {
    this.settings = readSettings(await this.loadData());
    this.registerView(
      VIEW_TYPE_HTML_PAGE_VIEWER,
      (leaf) => new HtmlPageViewerView(leaf, this),
    );
    this.registerFileExtensions();
    this.addSettingTab(new ViewerSettingTab(this.app, this));

    this.addCommand({
      id: "open-current-html-in-viewer",
      name: "Open current HTML file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.opens(file)) return false;

        if (!checking) {
          void this.openHtmlFile(file);
        }
        return true;
      },
    });

    // No default hotkey: in the viewer, Mod+F opens its find bar (#13).
    this.addCommand({
      id: "find-in-page",
      name: "Find in page",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(HtmlPageViewerView);
        if (!view) return false;
        if (!checking) view.openFind();
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

  /**
   * Changes and saves settings. Open tabs keep their Theme and Scripts state,
   * which the settings choose only for what opens next; wrapping applies at once.
   */
  async updateSettings(change: Partial<ViewerSettings>): Promise<void> {
    this.settings = { ...this.settings, ...change };
    if (change.extensions) this.registration?.apply(this.settings.extensions);
    (this.app.workspace as Events).trigger(SETTINGS_CHANGE);
    await this.saveData(this.settings);
  }

  /**
   * Registers the viewer for the listed extensions. Through Obsidian's view
   * registry, it follows changes of the setting at once; without it, Obsidian's
   * API registers them once, and a change applies when the plugin loads again.
   */
  private registerFileExtensions(): void {
    const registry = extensionRegistry(this.app);
    if (registry) {
      this.registration = new ExtensionRegistration(registry, VIEW_TYPE_HTML_PAGE_VIEWER);
      this.registration.apply(this.settings.extensions);
      this.register(() => this.registration?.releaseAll());
      return;
    }
    for (const extension of this.settings.extensions) {
      try {
        this.registerExtensions([extension], VIEW_TYPE_HTML_PAGE_VIEWER);
        this.fixedExtensions.held.push(extension);
      } catch {
        // Another view opens it.
        this.fixedExtensions.refused.push(extension);
      }
    }
  }

  get extensionsApplyAtOnce(): boolean {
    return this.registration !== null;
  }

  get refusedExtensions(): readonly string[] {
    return this.registration?.refused ?? this.fixedExtensions.refused;
  }

  /** Whether the viewer opens `file`, by its extension. */
  opens(file: TFile): boolean {
    const held = this.registration?.held ?? this.fixedExtensions.held;
    return held.includes(file.extension.toLowerCase());
  }
}

class HtmlPageViewerView extends TextFileView {
  private mode: ViewMode;
  private scriptsEnabled: boolean;
  private themeEnabled: boolean;
  private iframe: HTMLIFrameElement | null = null;
  /** The reading style in the frame's page, or null if it has none. */
  private shownStyle: string | null = null;
  private themeButton: HTMLButtonElement | null = null;
  private security: HTMLElement | null = null;
  private securityNote: HTMLElement | null = null;
  /** Whether the frame's page has its local files copied into it (#11). */
  private copyingFiles = false;

  /** The find bar's state, which it keeps when the view shows the page again (#13). */
  private readonly find = { open: false, query: "", index: 0 };
  private findMatches: Range[] = [];
  private findMore = false;
  private findHighlighter: Highlighter | null = null;
  private findBar: HTMLElement | null = null;
  private findTimer: number | null = null;

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
    // Obsidian's settings change through the vault's config. Obsidian 1.14
    // names the setting that changed; 1.5 names none.
    this.registerEvent(
      (this.app.vault as Events).on("config-changed", (setting?: unknown) => {
        if (setting === undefined || setting === "readableLineLength") this.updateTheme();
      }),
    );
    this.registerEvent(
      (this.app.workspace as Events).on(SETTINGS_CHANGE, () => {
        this.updateWrap();
        this.updateCopying();
      }),
    );

    // While the view has focus, Mod+F opens its find bar rather than Obsidian's,
    // which notes have and this view does not.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", () => {
      this.openFind();
      return false;
    });
    this.register(() => {
      this.cancelFindTimer();
      this.clearFindMatches();
    });
  }

  /**
   * Follows a change of the setting that copies local files into a page with
   * scripts on: the security note says what the page can read, in the source
   * view too, and a page with scripts on is shown again.
   */
  private updateCopying(): void {
    if (!this.scriptsEnabled) return;
    if (this.securityNote) this.securityNote.textContent = this.securityText();
    if (this.iframe !== null && this.plugin.settings.copyLocalFiles !== this.copyingFiles) this.render();
  }

  /** Wraps the source view's long lines, or not, as the settings say. */
  private updateWrap(): void {
    this.contentEl
      .querySelector<HTMLElement>(".html-page-viewer__source")
      ?.toggleClass("is-wrapped", this.plugin.settings.wrapSource);
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
    this.flushFindInput();
    this.clearFindMatches();
    this.findBar = null;
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    this.flushFindInput();
    this.clearFindMatches();
    container.empty();
    this.iframe = null;
    this.shownStyle = null;
    container.addClass("html-page-viewer");

    const header = container.createDiv({ cls: "html-page-viewer__header" });
    this.renderTitle(header);
    this.renderToolbar(header);
    this.findBar = this.find.open ? this.renderFindBar(container) : null;

    if (!this.file) {
      renderMessage(container, "No HTML file is attached to this viewer.");
      return;
    }

    if (!this.plugin.opens(this.file)) {
      renderMessage(
        container,
        `The viewer does not open .${this.file.extension} files. Its settings list the extensions it opens as HTML.`,
      );
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
    this.securityNote = security.createSpan({ text: this.securityText() });
    this.security = security;

    if (this.mode === "source") {
      renderSource(container, this.data);
      // Focusable, so that the find bar can give the keys back to it.
      container.querySelector(".html-page-viewer__source")?.setAttribute("tabindex", "-1");
      this.updateWrap();
      this.runFind();
      return;
    }

    this.renderIframe(container);
    // The page is searched once its document is there; until then, this says
    // why it cannot be, with scripts on.
    this.runFind();
  }

  private securityText(): string {
    if (!this.scriptsEnabled) {
      return "Sandbox blocks scripts, forms, popups, and top navigation; the page can show files from this vault.";
    }
    return this.plugin.settings.copyLocalFiles
      ? "Sandbox allows scripts, isolated from Obsidian; the page's local images, media, text tracks, fonts, and scripts are copied into it, where its scripts can read them. Forms, popups, and top navigation remain blocked."
      : "Sandbox allows scripts, isolated from Obsidian and from this vault's files; forms, popups, and top navigation remain blocked.";
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

    const findButton = createIconButton(toolbar, "search", "Find in page");
    findButton.addEventListener("click", () => (this.find.open ? this.closeFind() : this.openFind()));

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

  /** Opens the find bar, or focuses it if it is open, with its text selected. */
  openFind(): void {
    if (!this.find.open) {
      this.find.open = true;
      const header = this.contentEl.querySelector(".html-page-viewer__header");
      if (header) {
        this.findBar = this.renderFindBar(this.contentEl);
        header.after(this.findBar);
      }
      this.runFind();
    }
    const input = this.findBar?.querySelector("input");
    input?.focus();
    input?.select();
  }

  /** Closes the find bar; given `refocus`, the keys go back to what the view shows. */
  private closeFind(refocus = false): void {
    this.cancelFindTimer();
    this.find.open = false;
    this.clearFindMatches();
    this.findBar?.remove();
    this.findBar = null;
    if (refocus) {
      const shown = this.mode === "source" ? this.contentEl.querySelector<HTMLElement>(".html-page-viewer__source") : this.iframe;
      shown?.focus();
    }
  }

  private cancelFindTimer(): void {
    if (this.findTimer === null) return;
    this.contentEl.ownerDocument.defaultView?.clearTimeout(this.findTimer);
    this.findTimer = null;
  }

  /** Takes the text typed into the find bar before the bar is replaced, if it has not been searched yet. */
  private flushFindInput(): void {
    if (this.findTimer === null) return;
    this.cancelFindTimer();
    const input = this.findBar?.querySelector("input");
    if (input && input.value !== this.find.query) {
      this.find.query = input.value;
      this.find.index = 0;
    }
  }

  private renderFindBar(parent: HTMLElement): HTMLElement {
    const bar = parent.createDiv({ cls: "html-page-viewer__find" });
    const input = bar.createEl("input", {
      attr: { type: "search", placeholder: "Find", "aria-label": "Find in page", spellcheck: "false" },
    });
    input.value = this.find.query;
    bar.createSpan({ cls: "html-page-viewer__find-count", attr: { "aria-live": "polite" } });
    const previous = createIconButton(bar, "chevron-up", "Previous match");
    const next = createIconButton(bar, "chevron-down", "Next match");
    const close = createIconButton(bar, "x", "Close find");

    const win = parent.ownerDocument.defaultView;
    input.addEventListener("input", () => {
      // Searching a long page at every key would make typing lag.
      this.cancelFindTimer();
      this.findTimer =
        win?.setTimeout(() => {
          this.findTimer = null;
          if (!this.contentEl.contains(input)) return;
          this.find.query = input.value;
          this.find.index = 0;
          this.runFind();
        }, 150) ?? null;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.cancelFindTimer();
        if (input.value !== this.find.query) {
          this.find.query = input.value;
          this.find.index = 0;
          this.runFind();
        } else {
          this.moveFind(event.shiftKey ? -1 : 1);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.closeFind(true);
      }
    });
    previous.addEventListener("click", () => this.moveFind(-1));
    next.addEventListener("click", () => this.moveFind(1));
    close.addEventListener("click", () => this.closeFind());
    return bar;
  }

  /**
   * The text to find in, and the window that shows it: the source view's, or
   * the page's while the view can reach it. Null while there is nothing to
   * search yet, and a message where the view cannot search.
   */
  private findTarget(): { runs: TextRun[]; win: Window | null } | string | null {
    if (this.mode === "source") {
      const source = this.contentEl.querySelector(".html-page-viewer__source");
      return source ? { runs: sourceRuns(source), win: this.contentEl.ownerDocument.defaultView } : null;
    }
    if (this.scriptsEnabled) return "Find works in the source view while scripts are on.";
    const doc = this.iframe?.contentDocument;
    if (!doc || doc.URL !== "about:srcdoc" || doc.readyState === "loading") return null;
    if (!doc.getElementById(FIND_STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = FIND_STYLE_ID;
      style.textContent = FIND_STYLE;
      doc.head.append(style);
    }
    return { runs: pageRuns(doc), win: doc.defaultView };
  }

  /** Finds the find bar's text in what the view shows, and shows the current match. */
  private runFind(): void {
    // Not for a bar that the view has replaced.
    if (!this.find.open || !this.findBar || !this.contentEl.contains(this.findBar)) return;
    this.clearFindMatches();
    const target = this.findTarget();
    if (target === null || typeof target === "string") {
      this.setFindCount(target ?? "");
      return;
    }
    const { ranges, more } = findRanges(target.runs, this.find.query);
    this.findMatches = ranges;
    this.findMore = more;
    this.findHighlighter = new Highlighter(target.win);
    this.find.index = Math.min(this.find.index, Math.max(ranges.length - 1, 0));
    this.showFindMatch();
  }

  private moveFind(step: number): void {
    const count = this.findMatches.length;
    if (count === 0) return;
    this.find.index = (this.find.index + step + count) % count;
    this.showFindMatch(false);
  }

  /** Shows the current match, and with `all`, every match. */
  private showFindMatch(all = true): void {
    const count = this.findMatches.length;
    const current = this.findMatches[this.find.index] ?? null;
    if (all) this.findHighlighter?.show(this.findMatches, current);
    else this.findHighlighter?.setCurrent(current);
    if (count === 0) {
      this.setFindCount(this.find.query === "" ? "" : "No matches");
    } else {
      this.setFindCount(`${this.find.index + 1} of ${count}${this.findMore ? "+" : ""}`);
    }
    if (current) scrollToRange(current);
  }

  private setFindCount(text: string): void {
    const count = this.findBar?.querySelector(".html-page-viewer__find-count");
    if (count) count.textContent = text;
  }

  private clearFindMatches(): void {
    this.findHighlighter?.clear();
    this.findHighlighter = null;
    this.findMatches = [];
    this.findMore = false;
  }

  /** The reading style for Obsidian's current theme and settings. */
  private readingStyle(): string {
    // `getConfig` is not in Obsidian's API types, though Obsidian 1.5 and later
    // have it. Readable line length is on by default.
    const vault = this.app.vault as unknown as { getConfig?: (setting: string) => unknown };
    return readingStylesheet(readTheme(this.contentEl.ownerDocument), vault.getConfig?.("readableLineLength") !== false);
  }

  /**
   * Follows a change of Obsidian's theme or of its Readable line length setting
   * in the page, in place where possible.
   */
  private updateTheme(): void {
    const iframe = this.iframe;
    if (!iframe || this.shownStyle === null) return;
    const next = this.readingStyle();
    if (next === this.shownStyle) return;
    const style = iframe.contentDocument?.getElementById(READING_STYLE_ID);
    if (style) {
      style.textContent = styleElementText(next);
      this.shownStyle = next;
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
    const readingStyle = this.themeEnabled ? this.readingStyle() : undefined;
    // Only a page with scripts on needs its files copied: with scripts off, it
    // loads them itself.
    const copyFiles = this.scriptsEnabled && this.plugin.settings.copyLocalFiles ? this.localFiles() : undefined;
    this.copyingFiles = copyFiles !== undefined;
    let page: string;
    let ownStyles = false;
    let shownStyle: string | null = null;
    let leftOut = 0;
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
        { readingStyle, copyFiles },
      );
      page = prepared.html;
      ownStyles = prepared.ownStyles;
      leftOut = prepared.copiedFiles?.leftOut ?? 0;
      // preparePage adds the reading style only to pages without styles.
      shownStyle = ownStyles ? null : (readingStyle ?? null);
    } catch (error) {
      console.error("HTML Page Viewer: could not prepare the page", error);
      page = data;
    }
    if (this.iframe !== iframe) return;
    this.shownStyle = shownStyle;
    if (leftOut > 0) {
      this.security?.createSpan({
        cls: "html-page-viewer__copy-limit",
        text:
          leftOut === 1
            ? "One local file was left out of the page, over the size limits."
            : `${leftOut} local files were left out of the page, over the size limits.`,
      });
    }
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
        // Search the page as soon as its text is there, before its images load.
        if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", () => this.runFind());
        else this.runFind();
        // Keys pressed in the page go to its own document, not to Obsidian.
        doc.addEventListener("keydown", (event) => {
          if (isFindKey(event)) {
            event.preventDefault();
            this.openFind();
          }
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

  /** The vault's files, as preparePage copies them into a page with scripts on. */
  private localFiles(): LocalFiles {
    const vault = this.app.vault;
    const fileAt = (path: string): TFile | null => {
      const target = vault.getAbstractFileByPath(path);
      return target instanceof TFile ? target : null;
    };
    return {
      size: (path) => fileAt(path)?.stat.size ?? null,
      readBinary: async (path) => {
        const file = fileAt(path);
        if (file === null) return null;
        try {
          return await vault.readBinary(file);
        } catch {
          // The file went away after the view saw it.
          return null;
        }
      },
    };
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
      // The message replaces the find bar too.
      this.closeFind();
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
  let lineNumber = 0;
  const startLine = (): HTMLElement => {
    lineNumber += 1;
    const lineEl = pre.createDiv({ cls: "html-page-viewer__source-line" });
    lineEl.createSpan({ cls: "html-page-viewer__line-number", text: String(lineNumber) });
    return lineEl.createSpan({ cls: "html-page-viewer__source-code" });
  };

  // A token can continue over several lines, as a comment or a tag can, and
  // keeps its highlighting on each of them.
  let code = startLine();
  for (const token of tokenizeHtml(data)) {
    token.text.split("\n").forEach((part, index) => {
      if (index > 0) code = startLine();
      if (part === "") return;
      if (token.kind === "text") {
        code.appendText(part);
      } else {
        code.createSpan({ cls: `html-page-viewer__tok-${token.kind}`, text: part });
      }
    });
  }
}

type TokenKind = "text" | "comment" | "punctuation" | "tag" | "attr" | "string";

interface Token {
  readonly kind: TokenKind;
  text: string;
}

/** Elements whose contents HTML reads as text up to their end tag. */
const RAW_TEXT_ELEMENTS = new Set(["iframe", "noembed", "noframes", "script", "style", "textarea", "title", "xmp"]);

/** HTML's whitespace, which excludes the other spaces that `\s` matches. */
const HTML_SPACE = /[\t\n\f\r ]/;

/** What ends a tag's name, an attribute's name, and a value without quotes. */
const TAG_NAME_END = /[\t\n\f\r />]/;
const ATTRIBUTE_NAME_END = /[\t\n\f\r />=]/;
const UNQUOTED_VALUE_END = /[\t\n\f\r >]/;

/**
 * Splits HTML into tokens to highlight, where HTML's tokenizer would see tags,
 * comments, and text. The tokens' texts together are exactly `html`.
 */
function tokenizeHtml(html: string): Token[] {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string): void => {
    if (text === "") return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === kind) {
      last.text += text;
    } else {
      tokens.push({ kind, text });
    }
  };

  let cursor = 0;
  while (cursor < html.length) {
    const start = nextMarkupStart(html, cursor);
    if (start === -1) {
      push("text", html.slice(cursor));
      break;
    }
    push("text", html.slice(cursor, start));

    if (html.startsWith("<!--", start)) {
      cursor = commentEnd(html, start);
      push("comment", html.slice(start, cursor));
      continue;
    }

    const isEndTag = html[start + 1] === "/";
    const nameStart = start + (isEndTag ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
      // A doctype, or another construct that HTML skips up to the next ">".
      const end = html.indexOf(">", start + 2);
      cursor = end === -1 ? html.length : end + 1;
      push("punctuation", html.slice(start, cursor));
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < html.length && !TAG_NAME_END.test(html[nameEnd])) nameEnd += 1;
    push("punctuation", html.slice(start, nameStart));
    push("tag", html.slice(nameStart, nameEnd));
    const end = tokenizeAttributes(html, nameEnd, push);
    if (end === -1) break;
    cursor = end;

    const name = html.slice(nameStart, nameEnd).toLowerCase();
    if (isEndTag) continue;
    if (name === "plaintext") {
      push("text", html.slice(cursor));
      break;
    }
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const end = rawTextEnd(html, cursor, name);
      push("text", html.slice(cursor, end));
      cursor = end;
    }
  }
  return tokens;
}

/** Where the next tag, comment, or declaration starts: a `<` that HTML reads as markup. */
function nextMarkupStart(html: string, from: number): number {
  let start = html.indexOf("<", from);
  while (start !== -1 && !/[A-Za-z/!?]/.test(html[start + 1] ?? "")) {
    start = html.indexOf("<", start + 1);
  }
  return start;
}

/** The end of the comment that starts at `start`, or of `html` if it has none. */
function commentEnd(html: string, start: number): number {
  const body = start + 4;
  // `<!-->` and `<!--->` are whole comments.
  if (html.startsWith(">", body)) return body + 1;
  if (html.startsWith("->", body)) return body + 2;
  const close = /--!?>/g;
  close.lastIndex = body;
  const match = close.exec(html);
  return match ? match.index + match[0].length : html.length;
}

/**
 * Tokenizes a tag's attributes from `start`, after its name, and returns where
 * the tag ends: after its `>`, which a quoted value can contain, or -1 if the
 * file ends first.
 */
function tokenizeAttributes(html: string, start: number, push: (kind: TokenKind, text: string) => void): number {
  let cursor = start;
  while (cursor < html.length) {
    const char = html[cursor];
    if (char === ">") {
      push("punctuation", char);
      return cursor + 1;
    }
    if (char === "/" || HTML_SPACE.test(char)) {
      push("punctuation", char);
      cursor += 1;
      continue;
    }

    // A name runs up to whitespace, "/", ">", or "=", and can start with "=".
    const nameStart = cursor;
    cursor += 1;
    while (cursor < html.length && !ATTRIBUTE_NAME_END.test(html[cursor])) cursor += 1;
    push("attr", html.slice(nameStart, cursor));

    let equals = cursor;
    while (equals < html.length && HTML_SPACE.test(html[equals])) equals += 1;
    if (html[equals] !== "=") continue;

    const separatorStart = cursor;
    cursor = equals + 1;
    while (cursor < html.length && HTML_SPACE.test(html[cursor])) cursor += 1;
    push("punctuation", html.slice(separatorStart, cursor));

    const quote = html[cursor];
    if (quote === "\"" || quote === "'") {
      const close = html.indexOf(quote, cursor + 1);
      const end = close === -1 ? html.length : close + 1;
      push("string", html.slice(cursor, end));
      cursor = end;
    } else {
      const valueStart = cursor;
      while (cursor < html.length && !UNQUOTED_VALUE_END.test(html[cursor])) cursor += 1;
      push("string", html.slice(valueStart, cursor));
    }
  }
  return -1;
}

/** Where the text of a raw text element such as `script` ends: at its end tag. */
function rawTextEnd(html: string, start: number, name: string): number {
  const endTag = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
  endTag.lastIndex = start;
  return endTag.exec(html)?.index ?? html.length;
}

/** Whether a key press asks to find, as Mod+F does in Obsidian. */
function isFindKey(event: KeyboardEvent): boolean {
  const mod = Platform.isMacOS ? event.metaKey : event.ctrlKey;
  // The code names the key where it is, for layouts whose F key types another letter.
  return mod && !event.altKey && !event.shiftKey && (event.key.toLowerCase() === "f" || event.code === "KeyF");
}

/**
 * Scrolls a match into view: its element first, as nested scrolling areas need,
 * and then the window, as the element can be taller than the window, as a
 * `<pre>` or a page's text directly in its body is.
 */
function scrollToRange(range: Range): void {
  range.startContainer.parentElement?.scrollIntoView?.({ block: "center", inline: "nearest" });
  const win = range.startContainer.ownerDocument?.defaultView;
  const box = range.getBoundingClientRect?.();
  if (!win || !box || (box.width === 0 && box.height === 0)) return;
  if (box.top < 0 || box.bottom > win.innerHeight) win.scrollBy(0, box.top - win.innerHeight / 2);
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
