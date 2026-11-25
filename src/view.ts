// The view that shows an HTML file in a tab: Obsidian's file lifecycle, the
// toolbar, the sandboxed frame with the page's copy, what its find bar searches,
// and the split view's scrolling in step.

import {
  type Events,
  Notice,
  Platform,
  Scope,
  TFile,
  TextFileView,
  type WorkspaceLeaf,
} from "obsidian";
import { createIconButton, createTextButton } from "./buttons";
import { type LocalFiles, preparePage, styleElementText, withoutQuery } from "./document";
import { FIND_STYLE, FIND_STYLE_ID, pageRuns, sourceRuns } from "./find";
import { FindBar, type FindHost, type FindTarget } from "./find-bar";
import { type PaneChoice, watchLinks } from "./links";
import { READING_STYLE_ID, readingStylesheet, readTheme } from "./reading";
import {
  frameShows,
  isPinned,
  keepPageScrolling,
  keepScrolling,
  type KeptPageScrolling,
  type KeptScrolling,
  type NextDocumentFollowing,
  placeNextDocument,
  type PreviousDocument,
  type ReaderActivity,
  type ReaderWatch,
  type ScrollPlace,
  scrollInstantly,
  scrollPlace,
  watchElementHiding,
  watchHiding,
  watchReader,
} from "./scrolling";
import type { ViewerSettings } from "./settings";
import { renderSource, startTags } from "./source";
import {
  anchorElements,
  lineAtTop,
  lineForPageTop,
  linePlacing,
  onFirstResize,
  onResizes,
  pageTopForLine,
  remeasured,
  ScrollFollower,
  type SideName,
  syncPoints,
  topOfLine,
} from "./split";

export const VIEW_TYPE_HTML_PAGE_VIEWER = "html-page-viewer";
/** The workspace event that tells open views the settings changed. */
export const SETTINGS_CHANGE = "html-page-viewer:settings-change";

type ViewMode = "rendered" | "source" | "split";

/** The toolbar choices that a tab keeps from one file to the next. */
export interface TabChoices {
  readonly mode: ViewMode;
  readonly theme: boolean;
}

/** The plugin, as its views use it. */
export interface ViewerHost {
  readonly settings: ViewerSettings;
  /** Each tab's choices, which outlive the view that made them. */
  readonly tabChoices: WeakMap<WorkspaceLeaf, TabChoices>;
  /** Whether the viewer opens `file`, by its extension. */
  opens(file: TFile): boolean;
}

/** The split view's following of its two sides, from `syncScrolling`. */
interface SplitScrolling extends NextDocumentFollowing {
  readonly follower: ScrollFollower;
  /**
   * Obsidian hides the tab: the source's scrolling is not followed, nor the
   * hidden page's, and the source keeps its place, until `shown` (#178).
   */
  hid(): void;
  /**
   * The tab shows again, and the page is back where it was: so is the source,
   * unless the reader has scrolled it since `hid`, and then it leads. The
   * sides' reports of their going back lead neither.
   */
  shown(): void;
}

/**
 * What the view keeps of the frame's previous document for its next one:
 * PreviousDocument's place and leader, which the view writes here, and the
 * window that the view showed it in.
 */
interface FrameHistory extends PreviousDocument {
  place: ScrollPlace | null;
  led: SideName | null;
  /** The window that the view showed the previous document in, or null before the first (#165). */
  shownIn: Window | null;
}

/**
 * How long after a split view shows its page in a new window the view waits
 * for the source's lines to be laid out again, when Obsidian's styles arrive
 * there (#165). In moves on Obsidian 1.5.3 in Docker, which #165 and #176
 * record, the lines changed 111 to 277 ms after the view showed the page, and
 * up to 897 ms after it when a test held app.css back on a busy machine.
 */
const NEW_WINDOW_SETTLING = 2000;

export class HtmlPageViewerView extends TextFileView implements FindHost {
  private mode: ViewMode;
  private scriptsEnabled: boolean;
  private themeEnabled: boolean;
  private iframe: HTMLIFrameElement | null = null;
  /**
   * Where the source of the source view or the split view is scrolled to,
   * for after its tab moves (#135, #157).
   */
  private sourceScrolling: KeptScrolling | null = null;
  /**
   * The watch of a source that shows without a page that the view can reach,
   * in the **Source** view (#189) or in the split view with scripts on (#204),
   * of whether it shows, as Obsidian hides the tab and shows it again, and of
   * its window, and what ends it with that source.
   */
  private sourceHiding: { readonly moved: () => void; readonly end: AbortController } | null = null;
  /**
   * Where the frame's page is scrolled to, for after Obsidian hid the tab and
   * showed it again (#178), while the view can reach the page.
   */
  private pageScrolling: KeptScrolling | null = null;
  /**
   * What the reader does in the view while the frame has dropped its page's
   * document and the view does not show the next one yet, as after its tab
   * moved (#157).
   */
  private readerWatch: ReaderWatch | null = null;
  /** The reading style in the frame's page, or null if it has none. */
  private shownStyle: string | null = null;
  private themeButton: HTMLButtonElement | null = null;
  private security: HTMLElement | null = null;
  private securityNote: HTMLElement | null = null;
  /** Whether the frame's page has its local files copied into it (#11). */
  private copyingFiles = false;

  private readonly findBar = new FindBar(this);

  /**
   * Counts the changes of what the view shows: each time a file opens in it,
   * and each time it reads its file again. Such a read applies its result only
   * while it is the latest and the view still shows its file (#90).
   */
  private contentsVersion = 0;
  /**
   * The contents that the view shows. Obsidian sets `data` itself before it
   * gives the view a file's contents, also contents that the view does not
   * show then (#115).
   */
  private shownData = "";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ViewerHost,
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
    // After the tab moves to another tab group or window, Obsidian 1.5.3 shows
    // the source of the source view and the split view from its top. In
    // another tab group, the layout change that follows is all that the view
    // learns of the move (#135). Obsidian 1.5.3 sends it in a microtask after
    // the script that moves the tab, so before the reader can scroll (#157).
    this.registerEvent(this.app.workspace.on("layout-change", () => this.restoreAfterMove()));
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
    /* eslint-disable obsidianmd/no-unsupported-api -- declared from 1.5.7, but find.e2e.ts measures it in 1.5.3 */
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", () => {
      this.openFind();
      return false;
    });
    /* eslint-enable obsidianmd/no-unsupported-api -- the end of the scope's use */
    this.register(() => {
      this.findBar.end();
      this.stopReaderWatch();
      this.stopSourceHiding();
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
    if (this.iframe !== null && this.plugin.settings.copyLocalFiles !== this.copyingFiles)
      this.render();
  }

  /** Wraps the source view's long lines, or not, as the settings say. */
  private updateWrap(): void {
    this.contentEl
      .querySelector<HTMLElement>(".html-page-viewer__source")
      ?.toggleClass("is-wrapped", this.plugin.settings.wrapSource);
  }

  override onResize(): void {
    super.onResize();
    // A new window that the tab moved to lays the view's source out only
    // after the layout change that follows, and then resizes the view (#135).
    this.restoreAfterMove();
  }

  /**
   * Shows the source where it was, and the find bar's matches in it, if the
   * tab's move lost them (#135, #162). The matches are found again without
   * scrolling to the current one, which would take the source away from its
   * place. The frame's page is searched again when the frame shows its next
   * document. The **Source** view's source is watched in its new window, as
   * it can show again there before the watch in its first window reports it
   * (#189).
   */
  private restoreAfterMove(): void {
    this.sourceHiding?.moved();
    this.sourceScrolling?.restore();
    if (this.mode !== "rendered") this.findBar.restoreIn(this.contentEl.ownerDocument.defaultView);
  }

  getDisplayText(): string {
    return this.file?.basename ?? "HTML page viewer";
  }

  getIcon(): string {
    return "file-code-2";
  }

  setViewData(data: string, clear: boolean): void {
    if (!clear) {
      // Obsidian read the view's file again because the vault reported a
      // change. It passes on what it read without checking that the view
      // still shows that file, and another file can have opened in the tab
      // during the read (#115). The view keeps what it shows, and reads the
      // file that it shows itself.
      this.data = this.shownData;
      const file = this.file;
      if (file) void this.readFile(file);
      return;
    }
    // Obsidian sets `clear` when a different file opens in this view, which
    // must start with scripts as the settings say, like a new tab. Clearing
    // also drops a read still pending for what the view showed.
    this.clear();
    this.showContents(data);
  }

  /** Shows `data` as the contents of the view's file. */
  private showContents(data: string): void {
    this.data = data;
    this.shownData = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  /*
   * The viewer never writes the file it shows. TextFileView, which gives this
   * view Obsidian's file loading, also saves `getViewData()` to the file
   * whenever it differs from what Obsidian last read: when another file opens
   * in the tab, when the view closes or the tab shows another view, when
   * Obsidian quits, and after `requestSave`. A refresh changes the view's data
   * without Obsidian knowing, so any of those would write it (#90). In
   * Obsidian 1.5.3 and 1.15.1, all of them go through `save`, which therefore
   * does nothing; `requestSave` does nothing either, so that Obsidian never
   * takes the view for changed. After Obsidian's reload of a changed file
   * that ends once another file has opened in the tab (#115), what Obsidian
   * records as last read from the second file is the first file's contents,
   * so a save would also compare with the wrong file's contents.
   */
  override save(): Promise<void> {
    return Promise.resolve();
  }

  override requestSave = (): void => {
    // Nothing to save: see `save`.
  };

  clear(): void {
    // A refresh still pending for what this view showed no longer owns it.
    this.contentsVersion += 1;
    this.data = "";
    this.shownData = "";
    this.scriptsEnabled = this.plugin.settings.scriptsOn;
    this.iframe = null;
    this.findBar.detach();
    this.stopSourceHiding();
    this.contentEl.empty();
  }

  /**
   * Keeps the source of the **Source** view, or of the split view with scripts
   * on, at the line at its top, which can wrap otherwise after its tab moves
   * or shows again (#189, #204). Chromium lays it out again as far down as it
   * was when the tab shows, before the window paints, and reports no scroll
   * for that; it does not report the scroll to its start while hidden either.
   * Its place is held while it is hidden.
   */
  private keepSourcePlace(source: HTMLElement): void {
    const scrolling = keepScrolling(source, linePlacing(source));
    this.sourceScrolling = scrolling;
    const end = new AbortController();
    const watch = watchElementHiding(source, end.signal, {
      hid: () => scrolling.hold(),
      shown: () => scrolling.back(),
    });
    let shownIn = source.ownerDocument.defaultView;
    const lines = source.querySelector("pre");
    this.sourceHiding = {
      moved: () => {
        watch.moved();
        const win = source.ownerDocument.defaultView;
        if (win === shownIn) return;
        shownIn = win;
        // Obsidian 1.5.3 lays a new window's elements out before its styles
        // arrive there, and the source's lines then take other heights under
        // it: it goes back to its line at each change soon after (#165).
        if (lines) onResizes(lines, () => scrolling.again(), end.signal, NEW_WINDOW_SETTLING);
      },
      end,
    };
  }

  /** Stops the watch that keepSourcePlace started. */
  private stopSourceHiding(): void {
    this.sourceHiding?.end.abort();
    this.sourceHiding = null;
  }

  private render(): void {
    const container = this.contentEl;
    this.findBar.detach();
    container.empty();
    this.iframe = null;
    // Emptying the view drops the frame's page, which starts a watch of the
    // reader for the frame's next page; this view shows a new frame instead.
    this.stopReaderWatch();
    this.stopSourceHiding();
    this.sourceScrolling = null;
    this.pageScrolling = null;
    this.shownStyle = null;
    container.addClass("html-page-viewer");

    const header = container.createDiv({ cls: "html-page-viewer__header" });
    this.renderTitle(header);
    this.renderToolbar(header);
    this.findBar.attach(container);

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
      const source = renderSource(container, this.data);
      // Focusable, so that the find bar can give the keys back to it.
      source.setAttribute("tabindex", "-1");
      this.keepSourcePlace(source);
      this.updateWrap();
      this.findBar.run();
      return;
    }

    if (this.mode === "split") {
      // The source beside the page, or above it in a narrow view (styles.css).
      const split = container.createDiv({ cls: "html-page-viewer__split" });
      const source = renderSource(split, this.data);
      source.setAttribute("tabindex", "-1");
      // On Obsidian 1.5.3, the source would show its top after a move until it
      // followed the page, and a scroll of the reader's would start there.
      // When the tab shows again, and after a move, it goes back to its line,
      // which can wrap otherwise there, and leads from it where it led last
      // (#182, #189, #195). With scripts on, no page's frame tells the view
      // of either, so the source's own watch does (#204).
      if (this.scriptsEnabled) this.keepSourcePlace(source);
      else this.sourceScrolling = keepScrolling(source, linePlacing(source));
      this.updateWrap();
      this.renderIframe(split);
      this.findBar.run();
      return;
    }

    this.renderIframe(container);
    // The page is searched once its document is there; until then, this says
    // why it cannot be, with scripts on.
    this.findBar.run();
  }

  private securityText(): string {
    if (!this.scriptsEnabled) {
      return "Sandbox blocks scripts, forms, popups, and top navigation; the page can show files from this vault.";
    }
    const apart =
      this.mode === "split" ? " The source and the page scroll apart while scripts are on." : "";
    return (
      (this.plugin.settings.copyLocalFiles
        ? "Sandbox allows scripts, isolated from Obsidian; the page's local images, media, text tracks, fonts, and scripts are copied into it, where its scripts can read them. Forms, popups, and top navigation remain blocked."
        : "Sandbox allows scripts, isolated from Obsidian and from this vault's files; forms, popups, and top navigation remain blocked.") +
      apart
    );
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
    // Toggle buttons rather than tabs: each is an ordinary button, and the
    // pressed one is the mode shown.
    const modeGroup = toolbar.createDiv({
      cls: "html-page-viewer__segmented",
      attr: { role: "group", "aria-label": "View mode" },
    });
    const modes: [ViewMode, string][] = [
      ["rendered", "Rendered"],
      ["source", "Source"],
      ["split", "Split"],
    ];
    for (const [mode, label] of modes) {
      const button = createTextButton(modeGroup, label);
      button.toggleClass("is-active", this.mode === mode);
      button.setAttribute("aria-pressed", String(this.mode === mode));
      button.addEventListener("click", () => {
        this.mode = mode;
        this.rememberChoices();
        this.render();
      });
    }

    const findButton = createIconButton(toolbar, "search", "Find in page");
    findButton.addEventListener("click", () => this.findBar.toggle());

    const refreshButton = createIconButton(toolbar, "refresh-cw", "Refresh preview");
    refreshButton.addEventListener("click", () => {
      void this.reloadFile();
    });

    const scriptsButton = createTextButton(
      toolbar,
      this.scriptsEnabled ? "Scripts ON" : "Scripts OFF",
    );
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
    this.findBar.open();
  }

  focusShown(): void {
    const shown =
      this.mode === "rendered"
        ? this.iframe
        : this.contentEl.querySelector<HTMLElement>(".html-page-viewer__source");
    shown?.focus();
  }

  scrolledToMatch(): void {
    // What shows the match, the page in the rendered view and the source
    // otherwise, keeps where the find bar put it as its place (#167, #178).
    (this.mode === "rendered" ? this.pageScrolling : this.sourceScrolling)?.placed();
  }

  /** The source view's text and window, or the page's while the view can reach it. */
  findTarget(query: string): FindTarget | string | null {
    // The split view finds in its source, which the page follows while it can.
    if (this.mode !== "rendered") {
      const source = this.contentEl.querySelector(".html-page-viewer__source");
      return source
        ? {
            runs: query === "" ? [] : sourceRuns(source),
            win: this.contentEl.ownerDocument.defaultView,
          }
        : null;
    }
    if (this.scriptsEnabled) return "Find works in the source view while scripts are on.";
    const doc = this.iframe?.contentDocument;
    if (!doc || doc.URL !== "about:srcdoc" || doc.readyState === "loading") return null;
    if (!doc.getElementById(FIND_STYLE_ID)) {
      // eslint-disable-next-line obsidianmd/prefer-create-el -- the page's document, without Obsidian's helpers
      const style = doc.createElement("style");
      style.id = FIND_STYLE_ID;
      style.textContent = FIND_STYLE;
      doc.head.append(style);
    }
    return { runs: query === "" ? [] : pageRuns(doc), win: doc.defaultView };
  }

  /** The reading style for Obsidian's current theme and settings. */
  private readingStyle(): string {
    // `getConfig` is not in Obsidian's API types, though Obsidian 1.5 and later
    // have it. Readable line length is on by default.
    const vault = this.app.vault as unknown as { getConfig?: (setting: string) => unknown };
    return readingStylesheet(
      readTheme(this.contentEl.ownerDocument),
      vault.getConfig?.("readableLineLength") !== false,
    );
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
    if (this.scriptsEnabled) {
      // With scripts on, the page has an opaque origin, so prepare it again.
      this.render();
      return;
    }
    // The frame's document takes it now, or the next one as soon as the view
    // watches it.
    this.shownStyle = next;
    const doc = iframe.contentDocument;
    if (doc) this.restyle(doc);
  }

  /**
   * Gives a document of the frame the reading style that the view shows. The
   * frame loads the copy as it was prepared whenever it loads it again, as when
   * its tab moves to another tab group or window, so a style that the view has
   * changed in place since then would be undone (#126).
   */
  private restyle(doc: Document): void {
    if (this.shownStyle === null) return;
    const style = doc.getElementById(READING_STYLE_ID);
    const text = styleElementText(this.shownStyle);
    if (style && style.textContent !== text) style.textContent = text;
  }

  private renderIframe(parent: HTMLElement): void {
    const file = this.file;
    if (!file) {
      renderMessage(parent, "No HTML file is attached to this viewer.");
      return;
    }

    const frameWrap = parent.createDiv({ cls: "html-page-viewer__frame-wrap" });
    // The frame is built detached and joins the view with its sandbox already
    // set. Obsidian's main process serves vault files to a frame by the origin
    // it last recorded for it. A frame inserted without a sandbox is recorded
    // with Obsidian's origin, and on some hosts, such as Obsidian 1.5.3, its
    // page commits under that record: until the main process processes the
    // commit, it would serve the files that a page with scripts on asks for
    // (#83).
    const iframe = createEl("iframe", {
      cls: "html-page-viewer__frame",
      attr: {
        sandbox: sandboxValue(this.scriptsEnabled),
        title: file.name,
        referrerpolicy: "no-referrer",
      },
    });
    frameWrap.append(iframe);
    this.iframe = iframe;
    void this.loadPage(file, this.data, iframe);
  }

  /**
   * Shows a copy of the page in the frame, prepared so that its references to
   * vault files load and its protections apply (see document.ts), and nothing
   * if the view moved on meanwhile. If preparing the copy fails, the view says
   * so in the frame's place: the file as it is has none of the copy's
   * protections, so it is never shown instead.
   */
  private async loadPage(file: TFile, data: string, iframe: HTMLIFrameElement): Promise<void> {
    const pageUrl = withoutQuery(this.app.vault.getResourcePath(file));
    const depth = file.path.split("/").length - 1;
    const vaultUrl = new URL("../".repeat(depth) || "./", pageUrl).href;
    const readingStyle = this.themeEnabled ? this.readingStyle() : undefined;
    // Only a page with scripts on needs its files copied: with scripts off, it
    // loads them itself.
    const copyFiles =
      this.scriptsEnabled && this.plugin.settings.copyLocalFiles ? this.localFiles() : undefined;
    this.copyingFiles = copyFiles !== undefined;
    let page: string;
    let ownStyles = false;
    let madeInert = false;
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
          locate: (linktext) =>
            this.app.metadataCache.getFirstLinkpathDest(linktext, file.path)?.path ?? null,
        },
        // With scripts off, the view follows the page's links, also those in
        // shadow roots, and no document of the frame acts before the view
        // watches it.
        {
          readingStyle,
          copyFiles,
          openShadowRoots: !this.scriptsEnabled,
          inertUntilWatched: !this.scriptsEnabled,
        },
      );
      page = prepared.html;
      ownStyles = prepared.ownStyles;
      madeInert = prepared.madeInert;
      leftOut = prepared.copiedFiles?.leftOut ?? 0;
      // preparePage adds the reading style only to pages without styles.
      shownStyle = ownStyles ? null : (readingStyle ?? null);
    } catch (error) {
      console.error("HTML Page Viewer: could not prepare the page", error);
      if (this.iframe === iframe) this.showPreparationError(iframe, error);
      return;
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
    const sameOrigin = (iframe.getAttribute("sandbox") ?? "").includes("allow-same-origin");
    /**
     * Watches the frame's next document as soon as it exists, which is long
     * before its images have loaded and the frame fires load, whose listener
     * watches it otherwise. The page stays inert until then.
     */
    const look = (): void => {
      if (!sameOrigin) return;
      // A timer, not requestAnimationFrame, which pauses in windows that are
      // not painted. Without animation frames the window renders nothing, as
      // in the unit tests' jsdom, and only the load event remains.
      const win = iframe.ownerDocument.defaultView;
      if (!win?.requestAnimationFrame) return;
      const started = Date.now();
      const poll = (): void => {
        // A move detaches and reinserts the same frame; only a newer frame ends
        // the wait, so a move spread over several tasks is still watched.
        if (watch() || this.iframe !== iframe || Date.now() - started > 10_000) return;
        win.setTimeout(poll, 15);
      };
      poll();
    };
    const watched = new WeakSet<Document>();
    const frame: FrameHistory = { place: null, led: null, shownIn: null };
    const watch = (): boolean => {
      // Only a page with Obsidian's origin (scripts off) can be reached.
      const doc = iframe.contentDocument;
      if (!doc || doc.URL !== "about:srcdoc" || !doc.documentElement) return false;
      if (!watched.has(doc)) {
        watched.add(doc);
        watchLinks(doc, pageUrl, vaultUrl, Platform.isMacOS, {
          openVault: (path, pane, reference) =>
            void this.openVaultPath(path, pane, reference, file.path),
          openExternal: (url) => window.open(url),
          refuse: () => new Notice("This link leads outside the vault, so it was not opened."),
        });
        // Only now that its links lead where the view decides can the page act.
        if (madeInert) doc.documentElement.removeAttribute("inert");
        // Obsidian moves the tab's elements when the tab moves to another tab
        // group or window, and the frame then drops this document and loads
        // the copy again. Look for the next document once the script moving
        // the frame has run: while pagehide runs, this one is still the
        // frame's, and a timer would end with a window that closes.
        doc.defaultView?.addEventListener("pagehide", () => queueMicrotask(look));
        this.showDocument(iframe, doc, frame);
      }
      return true;
    };
    iframe.addEventListener("load", watch);
    iframe.srcdoc = page;
    if (ownStyles && this.themeButton) {
      this.themeButton.disabled = true;
      this.themeButton.setAttribute("title", "This page has styles of its own");
    }

    look();
    // A change of the theme or of Readable line length while the copy was
    // being prepared had no style to change yet.
    this.updateTheme();
  }

  /**
   * Shows a document of the frame as the view shows its page, once the view
   * watches it: in the reading style that the view shows, where the frame's
   * previous document was, with the find bar's matches, in step with the
   * source in the split view, and with the find keys. `frame` holds what the
   * view keeps of the frame's previous document, as when its tab moved to
   * another tab group or window (#126).
   */
  private showDocument(iframe: HTMLIFrameElement, doc: Document, frame: FrameHistory): void {
    this.restyle(doc);
    // The listeners that the view adds for this document outside it, as on
    // the split view's source, which outlive it unless removed.
    const showing = new AbortController();
    let placed = false;
    let kept: KeptPageScrolling | null = null;
    let split: SplitScrolling | null = null;
    /** Whether Obsidian hides the tab, as the frame's own window last laid it out (#178). */
    let hidden = false;
    // While pagehide runs, the document still has its layout, so it can say
    // where it is scrolled to; one that has not been placed yet keeps the
    // place that it was to show. A document in a hidden tab has no layout
    // to tell, and Chromium has scrolled it to its start: the element that
    // was at its top while the tab showed is its place (#186). The split
    // view's side that led last leads the next document too, or, where the
    // frame drops a document before the view has shown it, the side that led
    // before (#195), and its
    // source keeps its place until then: Obsidian and Chromium put it back as
    // far down as it was, or lay it out anew in a new window, which shows
    // other lines where they wrap otherwise there (#189).
    doc.defaultView?.addEventListener("pagehide", () => {
      showing.abort();
      if (placed) frame.place = hidden ? (kept?.place() ?? null) : scrollPlace(doc);
      frame.led = split?.follower.leading ?? frame.led;
      if (kept !== null && this.pageScrolling === kept) this.pageScrolling = null;
      if (this.iframe === iframe) {
        this.startReaderWatch();
        this.sourceScrolling?.hold();
      }
    });
    // Search the page, follow its scrolling in the split view, and show it
    // where the previous document was, as soon as its text is there, before
    // its images load. The reader's input in the view, as in the split view's
    // source or the find bar, also counts as their own scrolling, also before
    // the frame had this document. After a move, the find bar shows its
    // matches again without scrolling to the current one, which would take
    // the page, or the split view's source, away from its place (#157).
    const parsed = (): void => {
      this.restyle(doc);
      const reader = this.stopReaderWatch();
      // The view watches the reader only once the frame has dropped a page:
      // without a watch, this is the frame's first document. The split
      // view's source goes back to the line that it showed, or stays where
      // the reader scrolled it meanwhile, as the watch says, also where
      // Chromium reported that scroll only after the frame of their input.
      const firstDocument = reader === null;
      if (reader?.scrolled) this.sourceScrolling?.release();
      else if (reader) this.sourceScrolling?.back();
      this.findBar.run(firstDocument);
      const shownIn = this.contentEl.ownerDocument.defaultView;
      const newWindow = frame.shownIn !== null && frame.shownIn !== shownIn;
      frame.shownIn = shownIn;
      split =
        this.mode === "split" ? this.syncScrolling(iframe, doc, showing.signal, newWindow) : null;
      const shownPlace = placeNextDocument(
        doc,
        frame,
        reader,
        split,
        [this.contentEl],
        showing.signal,
      );
      placed = true;
      // When Obsidian hides the tab and shows it again, the page goes back to
      // what it showed, and the split view's sides are put in step there
      // (#178, #182). A frame that has no size yet, as one whose tab stays
      // hidden while Obsidian lays its tab group out anew, shows the place
      // that it was to show once it has one (#186).
      const pageScrolling = keepPageScrolling(iframe, doc, showing.signal, shownPlace);
      kept = pageScrolling;
      if (this.iframe === iframe) this.pageScrolling = kept;
      watchHiding(iframe, doc, showing.signal, {
        hid: () => {
          hidden = true;
          split?.hid();
        },
        shown: () => {
          hidden = false;
          pageScrolling?.back();
          split?.shown();
        },
      });
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", parsed);
    else parsed();
    // Keys pressed in the page go to its own document, not to Obsidian.
    doc.addEventListener("keydown", (event) => {
      if (isFindKey(event)) {
        event.preventDefault();
        this.openFind();
      }
    });
  }

  /**
   * Shows why the page could not be prepared, in place of its frame. The
   * toolbar stays, so Refresh tries again and the source view shows the file.
   */
  private showPreparationError(iframe: HTMLIFrameElement, error: unknown): void {
    this.iframe = null;
    const wrap = iframe.parentElement;
    const parent = wrap?.parentElement;
    if (!wrap || !parent) return;
    const text = `Unable to prepare this page, so it is not shown: ${getErrorMessage(error)}`;
    wrap.replaceWith(renderMessage(parent, text));
  }

  /**
   * Watches what the reader does in the view until it shows the frame's next
   * document. The view follows no scrolling of the split view's source
   * meanwhile, as it shows no page. A watch that runs already, as when the
   * frame drops a document that it never showed, goes on.
   */
  private startReaderWatch(): void {
    if (this.readerWatch !== null) return;
    this.readerWatch = watchReader(
      this.contentEl,
      this.contentEl.querySelector<HTMLElement>(
        ".html-page-viewer__split .html-page-viewer__source",
      ),
    );
  }

  /** Stops watching the reader, and says what they did while watched, or null without a watch. */
  private stopReaderWatch(): ReaderActivity | null {
    const activity = this.readerWatch?.stop() ?? null;
    this.readerWatch = null;
    return activity;
  }

  /**
   * Keeps the split view's source and page scrolling in step, while the view
   * can reach the page, from as soon as its text is there, until `signal`
   * says that the frame no longer shows `doc`, which the view shows in
   * another window than the frame's previous document if `newWindow`.
   * Returns the following, or null when the view cannot follow the page.
   */
  private syncScrolling(
    iframe: HTMLIFrameElement,
    doc: Document,
    signal: AbortSignal,
    newWindow: boolean,
  ): SplitScrolling | null {
    const win = doc.defaultView;
    const source = this.contentEl.querySelector<HTMLElement>(
      ".html-page-viewer__split .html-page-viewer__source",
    );
    const main = this.contentEl.ownerDocument.defaultView;
    if (!doc.body || !win || !source || !main?.requestAnimationFrame) return null;

    const anchors = anchorElements(doc.body, startTags(this.data));
    const root = doc.documentElement;
    const lines = this.data.split("\n").length;
    const now = (): number => main.performance.now();
    // Measured again when a side's height changes, as when images load or lines wrap.
    const points = remeasured(
      () =>
        syncPoints(
          anchors,
          (element) => {
            const box = element.getBoundingClientRect();
            if (box.width === 0 && box.height === 0) return null;
            return isPinned(element, win) ? null : box.top + win.scrollY;
          },
          { lines, height: root.scrollHeight },
        ),
      () => root.scrollHeight,
      now,
    );
    const lineTops = remeasured(
      () =>
        [...source.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")].map(
          (line) => line.offsetTop,
        ),
      () => source.scrollHeight,
      now,
    );
    const scroll = (target: Element | Window, top: number): void =>
      scrollInstantly(target, root, { top });
    /** Where the source last led from, and the line at its top there by the line tops of then (#165). */
    let sourceLed: { readonly top: number; readonly line: number } | null = null;
    const follower = new ScrollFollower(
      {
        source: {
          position: () => source.scrollTop,
          furthest: () => source.scrollHeight - source.clientHeight,
          scrollTo: (top) => scroll(source, top),
        },
        page: {
          position: () => win.scrollY,
          furthest: () => root.scrollHeight - root.clientHeight,
          scrollTo: (top) => scroll(win, top),
        },
      },
      {
        source: (top) => {
          const line = lineAtTop(lineTops(), top);
          sourceLed = { top, line };
          return pageTopForLine(points(), line);
        },
        page: (top) => {
          const line = lineForPageTop(points(), top);
          return line === null ? null : topOfLine(lineTops(), line);
        },
      },
      (run) =>
        main.requestAnimationFrame(() => {
          if (this.iframe === iframe && !signal.aborted) run();
        }),
    );
    /**
     * While Obsidian hides the tab, and until the sides are back (#178): what
     * the reader does in the view meanwhile. The source's scroll is not
     * followed then: Chromium can lay the source out elsewhere when the tab
     * shows, where its lines wrap, and report that before the frame's
     * observer reports. Following it would also measure the sides before
     * the view puts them back.
     */
    let hiding: ReaderWatch | null = null;
    source.addEventListener(
      "scroll",
      () => {
        if (hiding === null) follower.scrolled("source");
      },
      { signal },
    );
    /**
     * Until when the page follows the source whatever it reports, as a moved
     * page does until it loads (#195).
     */
    let pageFollows: AbortSignal | null = null;
    // The hidden page reports its scroll before the frame's observer reports
    // the frame hidden, and while its frame is not laid out.
    win.addEventListener(
      "scroll",
      () => {
        if (frameShows(iframe, doc) && (pageFollows === null || pageFollows.aborted))
          follower.scrolled("page");
      },
      { signal },
    );
    // The frame drops the document while the tab is hidden, as when the tab
    // moves then, and no `shown` comes for it: the source's place is no
    // longer held. A source taken out of the page with its tab has no layout,
    // so it keeps the place where it was held.
    signal.addEventListener(
      "abort",
      () => {
        if (hiding === null) return;
        hiding.stop();
        hiding = null;
        this.sourceScrolling?.release();
      },
      { once: true },
    );
    // Obsidian 1.5.3 lays a new window's elements out before its app.css has
    // arrived there, so the sides can be put in step for lines that then move
    // (#165). The first size change of the source's lines measures both sides
    // again, and the side that led last leads again. Only once, and only
    // soon after the move: an ordinary resize leaves the sides as they are
    // until the next scroll.
    const content = source.querySelector("pre");
    if (newWindow && content)
      onFirstResize(
        content,
        () => {
          // A source that led last keeps the line that it led from, where
          // the reader, the find bar, or its kept place put it, if it is
          // still where it led from: the change moved its lines, and left it
          // where it was in pixels, or at its end short of that, where its
          // lines take less room now (#195). One that Chromium has scrolled
          // elsewhere meanwhile, as scroll anchoring would, leads from where
          // it is.
          const top = source.scrollTop;
          const kept =
            follower.leading === "source" &&
            sourceLed &&
            (sourceLed.top === top ||
              (top < sourceLed.top && top >= source.scrollHeight - source.clientHeight - 1))
              ? sourceLed.line
              : null;
          points.again();
          lineTops.again();
          if (kept === null) {
            follower.again();
            return;
          }
          scroll(source, Math.round(topOfLine(lineTops(), kept)));
          follower.placed("source");
        },
        signal,
        NEW_WINDOW_SETTLING,
      );
    return {
      follower,
      sourceLeads: (until) => {
        pageFollows = until;
        points.again();
        follower.placed("source");
      },
      hid: () => {
        if (hiding !== null) return;
        this.sourceScrolling?.hold();
        hiding = watchReader(this.contentEl, source);
      },
      shown: () => {
        const reader = hiding?.stop();
        hiding = null;
        if (!reader) return;
        // The page has gone back already. The sides' reports of their going
        // back are not the reader's, and the sides are measured again, as
        // their layout was dropped.
        points.again();
        lineTops.again();
        follower.passOver("page");
        if (reader.scrolled) {
          // The reader scrolled the source as the tab showed again.
          this.sourceScrolling?.release();
          follower.placed("source");
          return;
        }
        this.sourceScrolling?.back();
        follower.passOver("source");
        // Chromium can lay the source out other than it was, and a pane can
        // change its width while the tab is hidden: the side that led last
        // puts the sides in step once.
        follower.again();
      },
    };
  }

  /**
   * Opens a vault file a link leads to; a folder opens its index page. A link
   * whose path leads nowhere opens the file Obsidian's link resolution finds
   * for it from this page, by name or by a partial path.
   */
  private async openVaultPath(
    path: string,
    pane: PaneChoice,
    reference: string,
    pagePath: string,
  ): Promise<void> {
    const vault = this.app.vault;
    const clean = path.replace(/\/+$/, "");
    let target = clean === "" ? vault.getRoot() : vault.getAbstractFileByPath(clean);
    if (target !== null && !(target instanceof TFile)) {
      const folder = clean === "" ? "" : `${clean}/`;
      target =
        vault.getAbstractFileByPath(`${folder}index.html`) ??
        vault.getAbstractFileByPath(`${folder}index.htm`);
    } else if (target === null) {
      let linktext = "";
      try {
        linktext = decodeURIComponent(withoutQuery(reference)).replace(/^\/+/, "");
      } catch {
        // A malformed reference names nothing.
      }
      target =
        linktext === "" ? null : this.app.metadataCache.getFirstLinkpathDest(linktext, pagePath);
    }
    if (target instanceof TFile) {
      await this.linkLeaf(pane).openFile(target);
    } else {
      new Notice(`There is no file at "${path}" in this vault.`);
    }
  }

  /**
   * The tab that a link in the page opens in, as Obsidian opens a link in a
   * note in this tab: this tab, unless it is pinned, or with a modifier a new
   * tab or split beside it, or a new window. Obsidian chooses from its active
   * tab, and a click in the page never makes this tab the active one, since
   * the frame's events do not reach Obsidian's window, so the view makes it
   * active first (#141).
   */
  private linkLeaf(pane: PaneChoice): WorkspaceLeaf {
    const workspace = this.app.workspace;
    workspace.setActiveLeaf(this.leaf, { focus: false });
    return workspace.getLeaf(pane);
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
      // preparePage leaves out a file whose read fails, as one that went away.
      readBinary: async (path) => {
        const file = fileAt(path);
        return file === null ? null : vault.readBinary(file);
      },
    };
  }

  private async readVaultText(path: string): Promise<string | null> {
    const target = this.app.vault.getAbstractFileByPath(path);
    return target instanceof TFile ? this.app.vault.cachedRead(target) : null;
  }

  private async reloadFile(): Promise<void> {
    const file = this.file;
    if (!file) {
      new Notice("No HTML file to refresh");
      return;
    }
    await this.readFile(file);
  }

  /** Reads the view's file again and shows its contents, or why it cannot be read. */
  private async readFile(file: TFile): Promise<void> {
    // Another file, the same file opened again, or a later read may take the
    // view while the file is read; then this read's result, or its error,
    // belongs to contents that the view no longer shows.
    const version = ++this.contentsVersion;
    const current = (): boolean => this.contentsVersion === version && this.file === file;
    try {
      const data = await this.app.vault.read(file);
      if (!current()) return;
      this.showContents(data);
    } catch (error) {
      if (!current()) return;
      // The message replaces the find bar too.
      this.findBar.close();
      this.contentEl.empty();
      this.stopReaderWatch();
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

/** Whether a key press asks to find, as Mod+F does in Obsidian. */
function isFindKey(event: KeyboardEvent): boolean {
  const mod = Platform.isMacOS ? event.metaKey : event.ctrlKey;
  // The code names the key where it is, for layouts whose F key types another letter.
  return (
    mod &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key.toLowerCase() === "f" || event.code === "KeyF")
  );
}

function renderMessage(parent: HTMLElement, message: string): HTMLElement {
  return parent.createDiv({ cls: "html-page-viewer__message", text: message });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
