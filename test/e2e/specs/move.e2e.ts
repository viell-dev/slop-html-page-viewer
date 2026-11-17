import { browser, expect } from "@wdio/globals";
import {
  ACTIVE,
  clickToolbarButton,
  moveActiveTab,
  openInActiveTab,
  waitForPage,
} from "../support/viewer.ts";

/** A page whose paragraphs wrap onto more lines in a narrower pane. */
const PARAGRAPHS = "Saved/Long paragraphs.html";

async function createParagraphsPage(): Promise<void> {
  const words =
    "Each paragraph of this synthetic page runs long enough to wrap onto several lines, so that its height depends on the width that the page is laid out at.";
  const paragraphs = Array.from(
    { length: 60 },
    (_, index) =>
      `<p id="p${index + 1}">Paragraph ${index + 1}. ${words.repeat(1 + (index % 3))}</p>`,
  ).join("\n");
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Long paragraphs</title>\n</head>\n<body>\n${paragraphs}\n</body>\n</html>\n`;
  await browser.executeObsidian(
    async ({ app }, path, html) => {
      if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, html);
    },
    PARAGRAPHS,
    html,
  );
}

interface PageState {
  /** Whether the frame shows the page in a document that has loaded, after a move a new one. */
  loaded: boolean;
  inWindow: boolean;
  /** The number of the first paragraph that the page shows at its top. */
  top: number;
  /** The widths of the page's text and of the frame's viewport, in CSS pixels. */
  text: number;
  viewport: number;
  /** The background that the page's root shows. */
  background: string;
  /** In the split view, the number of the first line that the source shows at its top. */
  line: number | null;
}

/**
 * What the active tab's page shows, or, given `moved`, the page of the tab
 * that moveActiveTab moved, in whichever window it is.
 */
async function pageState(moved: boolean): Promise<PageState | null> {
  return browser.executeObsidian(({ app }, moved) => {
    const frames: HTMLIFrameElement[] = [];
    if (moved) {
      app.workspace.iterateAllLeaves((leaf) => {
        const frame =
          leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe[data-e2e-moved]");
        if (frame) frames.push(frame);
      });
    } else {
      const frame = app.workspace
        .getMostRecentLeaf()
        ?.view.containerEl.querySelector<HTMLIFrameElement>("iframe.html-page-viewer__frame");
      if (frame) frames.push(frame);
    }
    const frame = frames[0];
    const doc = frame?.contentDocument;
    const win = doc?.defaultView;
    if (!frame || !doc?.body || !win) return null;
    const paragraph = [...doc.querySelectorAll("p")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > 1,
    );
    const source = frame
      .closest(".html-page-viewer__split")
      ?.querySelector<HTMLElement>(".html-page-viewer__source");
    let line: number | null = null;
    if (source) {
      const lines = [...source.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")];
      line =
        lines.findIndex((each) => each.offsetTop + each.offsetHeight > source.scrollTop + 1) + 1;
    }
    return {
      loaded:
        doc.URL === "about:srcdoc" &&
        doc.readyState === "complete" &&
        doc.documentElement.dataset.e2eBefore === undefined,
      inWindow: frame.ownerDocument !== document,
      top: Number(/Paragraph (\d+)/.exec(paragraph?.textContent ?? "")?.[1] ?? 0),
      text: doc.body.getBoundingClientRect().width,
      viewport: doc.documentElement.clientWidth,
      background: win.getComputedStyle(doc.documentElement).backgroundColor,
      line,
    };
  }, moved);
}

/** Waits until the moved tab's frame has loaded its page again, and the view has placed it. */
async function waitForMovedPage(): Promise<PageState> {
  let state: PageState | null = null;
  await browser.waitUntil(
    async () => {
      state = await pageState(true);
      return state?.loaded === true;
    },
    { timeout: 10_000, timeoutMsg: "the moved tab did not show its page again" },
  );
  // Then a moment for the scroll events that placing it makes to be followed.
  await browser.pause(500);
  return (await pageState(true))!;
}

/** Scrolls the active tab's page to show `fraction` of paragraph `number`'s height above its top. */
async function scrollToParagraph(number: number, fraction: number): Promise<void> {
  await browser.execute(
    (active, number, fraction) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      );
      const doc = frame?.contentDocument;
      const paragraph = doc?.getElementById(`p${number}`);
      if (!doc?.defaultView || !paragraph) throw new Error(`No paragraph ${number}`);
      const box = paragraph.getBoundingClientRect();
      doc.defaultView.scrollTo(0, doc.defaultView.scrollY + box.top + fraction * box.height);
    },
    ACTIVE,
    number,
    fraction,
  );
}

/** Switches Obsidian's base theme, as its appearance settings do. */
async function setDark(dark: boolean): Promise<void> {
  await browser.executeObsidian(({ app }, dark) => {
    const theme = dark ? "obsidian" : "moonstone";
    const internal = app as unknown as {
      changeTheme?: (name: string) => void;
      setTheme?: (name: string) => void;
    };
    if (internal.changeTheme) internal.changeTheme(theme);
    else internal.setTheme?.(theme);
  }, dark);
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.body.classList.contains("theme-dark"))) === dark,
    { timeoutMsg: `Obsidian did not switch to the ${dark ? "dark" : "light"} theme` },
  );
}

/** Sets Obsidian's "Readable line length", as its editor settings do. */
async function setReadableLineLength(on: boolean): Promise<void> {
  await browser.executeObsidian(({ app }, on) => {
    (app.vault as unknown as { setConfig(setting: string, value: unknown): void }).setConfig(
      "readableLineLength",
      on,
    );
  }, on);
}

/** Obsidian's background color, as a page in its theme shows it. */
async function themeBackground(): Promise<string> {
  return browser.execute(() => {
    const probe = document.body.createDiv();
    probe.style.background = "var(--background-primary)";
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
}

describe("A tab moved to another tab group or window in Obsidian", function () {
  beforeEach(async function () {
    await browser.executeObsidian(({ app }) => {
      // Closing a window's tabs closes the window.
      const away: { detach(): void }[] = [];
      app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.containerEl.ownerDocument !== document) away.push(leaf);
      });
      for (const leaf of away) leaf.detach();
      const fresh = app.workspace.getLeaf("tab");
      app.workspace.setActiveLeaf(fresh, { focus: true });
      const old: (typeof fresh)[] = [];
      app.workspace.iterateRootLeaves((leaf) => {
        if (leaf !== fresh) old.push(leaf);
      });
      for (const leaf of old) leaf.detach();
    });
  });

  after(async function () {
    await browser.executeObsidian(({ app }) => {
      const away: { detach(): void }[] = [];
      app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.containerEl.ownerDocument !== document) away.push(leaf);
      });
      for (const leaf of away) leaf.detach();
    });
  });

  it("shows its page where it was, in another tab group, where the page wraps differently", async function () {
    await createParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    // Without the theme's line width, the page takes the pane's width.
    await clickToolbarButton("Theme ON");
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    const before = (await pageState(false))!;
    expect(before).toMatchObject({ top: 30 });

    // A narrower tab group, where the paragraphs wrap onto more lines, so that
    // the height that the page was scrolled to would lead elsewhere. Obsidian
    // splits the tab group before it moves the tab, so the page also wraps at
    // half the width on the way, where Chromium keeps the paragraph at its
    // height in the window: how far into it the page is can change.
    await moveActiveTab("group", 400);
    const after = await waitForMovedPage();
    expect(after.text).toBeLessThan(before.text - 300);
    expect(after.top).toBe(30);
  });

  it("shows its page where it was, in a new window", async function () {
    await createParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(40, 0.25);
    const before = (await pageState(false))!;
    expect(before).toMatchObject({ top: 40 });

    await moveActiveTab("window");
    const after = await waitForMovedPage();
    expect(after.inWindow).toBe(true);
    expect(after.top).toBe(40);
  });

  it("keeps the theme and line width that the view changed in the page in place", async function () {
    await setDark(false);
    await openInActiveTab("Saved/Other page.html");
    await waitForPage();
    try {
      await setDark(true);
      await setReadableLineLength(false);
      const dark = await themeBackground();
      await browser.waitUntil(
        async () => {
          const state = await pageState(false);
          return state?.background === dark && Math.abs(state.viewport - state.text) < 1;
        },
        { timeoutMsg: "the page did not follow the theme and line width in place" },
      );

      await moveActiveTab("group");
      const after = await waitForMovedPage();
      expect(after.background).toBe(dark);
      expect(Math.abs(after.viewport - after.text)).toBeLessThan(1);
    } finally {
      await setReadableLineLength(true);
      await setDark(false);
    }
  });

  it("keeps the split view's sides in place and in step, following only the page it shows", async function () {
    // In the long page, paragraph N is on line 8 + N of the source.
    await openInActiveTab("Saved/Long page.html");
    await clickToolbarButton("Split");
    await waitForPage();
    await browser.execute((active) => {
      const source = document.querySelector<HTMLElement>(
        `${active} .html-page-viewer__split .html-page-viewer__source`,
      );
      const line = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[19];
      if (!source || !line) throw new Error("No line 20");
      source.scrollTop = line.offsetTop;
    }, ACTIVE);
    await browser.waitUntil(async () => Math.abs(((await pageState(false))?.top ?? 0) - 12) <= 1, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the source to paragraph 12",
    });

    // Counts each time something measures the page's document that the frame
    // is about to drop, as the split view's following of it does.
    await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      )!.contentDocument!;
      const state = window as unknown as { e2eDroppedReads: number };
      state.e2eDroppedReads = 0;
      const root = doc.documentElement;
      const height = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!.get!;
      Object.defineProperty(root, "scrollHeight", {
        configurable: true,
        get() {
          state.e2eDroppedReads += 1;
          return height.call(root) as number;
        },
      });
    }, ACTIVE);

    await moveActiveTab("group");
    const after = await waitForMovedPage();
    expect(Math.abs(after.top - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs((after.line ?? 0) - 20)).toBeLessThanOrEqual(1);

    // Line 30 is paragraph 22's.
    await browser.execute((active) => {
      const source = document.querySelector<HTMLElement>(
        `${active} .html-page-viewer__split .html-page-viewer__source`,
      );
      const line = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[29];
      if (!source || !line) throw new Error("No line 30");
      source.scrollTop = line.offsetTop;
    }, ACTIVE);
    await browser.waitUntil(async () => Math.abs(((await pageState(true))?.top ?? 0) - 22) <= 1, {
      timeout: 5000,
      timeoutMsg: "the moved page did not follow the source to paragraph 22",
    });
    expect(
      await browser.execute(
        () => (window as unknown as { e2eDroppedReads: number }).e2eDroppedReads,
      ),
    ).toBe(0);
  });
});
