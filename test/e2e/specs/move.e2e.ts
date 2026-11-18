import http from "node:http";
import type { AddressInfo } from "node:net";
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
/** The same paragraphs, followed by an image that arrives only when the test says. */
const HELD = "Saved/Held image.html";

/**
 * Long paragraphs numbered from `first`, with the ids `${prefix}${number}`,
 * which wrap onto more lines in a narrower pane.
 */
function paragraphs(first: number, count: number, prefix = "p", name = "Paragraph"): string {
  const words =
    "Each paragraph of this synthetic page runs long enough to wrap onto several lines, so that its height depends on the width that the page is laid out at.";
  return Array.from({ length: count }, (_, index) => {
    const number = first + index;
    return `<p id="${prefix}${number}">${name} ${number}. ${words.repeat(1 + ((number - 1) % 3))}</p>`;
  }).join("\n");
}

/** Writes a page of 60 long paragraphs to `path`, followed by `after`. */
async function writeParagraphsPage(path = PARAGRAPHS, after = ""): Promise<void> {
  await writePage(path, "Long paragraphs", "", `${paragraphs(1, 60)}\n${after}`);
}

/** Writes a page with `head` and `body` to `path` in the vault. */
async function writePage(path: string, title: string, head: string, body: string): Promise<void> {
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n${head}</head>\n<body>\n${body}</body>\n</html>\n`;
  await browser.executeObsidian(
    async ({ app }, path, html) => {
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) await app.vault.modify(existing as never, html);
      else await app.vault.create(path, html);
    },
    path,
    html,
  );
}

/**
 * A server whose image never arrives until `release`, which refuses it then
 * and afterwards: a page that shows it has its text long before it loads, as
 * a saved page whose images are on a host that no longer answers has.
 */
async function heldImage(): Promise<{ url: string; release(): void; close(): void }> {
  const held: http.ServerResponse[] = [];
  let released = false;
  const refuse = (response: http.ServerResponse): void => {
    response.writeHead(404);
    response.end();
  };
  const server = http.createServer((_request, response) => {
    if (released) refuse(response);
    else held.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/held.png`,
    release: () => {
      released = true;
      for (const response of held.splice(0)) refuse(response);
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

interface PageState {
  /** Whether the frame shows the page's copy, after a move in a new document. */
  shown: boolean;
  /** How far the page's document has loaded. */
  readyState: DocumentReadyState;
  inWindow: boolean;
  /** The number of the first paragraph that the page shows at its top. */
  top: number;
  /** How far the page is scrolled down, in CSS pixels. */
  scrollY: number;
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
      shown: doc.URL === "about:srcdoc" && doc.documentElement.dataset.e2eBefore === undefined,
      readyState: doc.readyState,
      inWindow: frame.ownerDocument !== document,
      top: Number(/Paragraph (\d+)/.exec(paragraph?.textContent ?? "")?.[1] ?? 0),
      scrollY: win.scrollY,
      text: doc.body.getBoundingClientRect().width,
      viewport: doc.documentElement.clientWidth,
      background: win.getComputedStyle(doc.documentElement).backgroundColor,
      line,
    };
  }, moved);
}

/**
 * Waits until the frame of the tab that moveActiveTab moved shows its page
 * again and `ready` holds for what it shows: by default, until the page has
 * loaded, when the view has placed it for the last time.
 */
async function waitForMovedPage(
  ready: (state: PageState) => boolean = (state) => state.readyState === "complete",
  what = "its page loaded again",
): Promise<PageState> {
  let state: PageState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await pageState(true);
        return state?.shown === true && ready(state);
      },
      { timeout: 10_000 },
    );
  } catch {
    throw new Error(`The moved tab did not show ${what}: ${JSON.stringify(state)}`);
  }
  return state!;
}

/** Waits until the active tab's page has its text, before it has loaded. */
async function waitForParsedPage(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const state = await pageState(false);
      return state?.shown === true && state.readyState === "interactive";
    },
    { timeoutMsg: "the page did not reach the state between parsing and loading" },
  );
}

/** Waits for two animation frames of Obsidian's window, after the split view's following. */
async function nextFrames(): Promise<void> {
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * Turns the mouse wheel down over the element of Obsidian's main window that
 * `selector` finds, as a reader scrolls, until the moved tab's page shows a
 * paragraph after `from` at its top and has stopped scrolling.
 */
async function wheelDown(selector: string, from: number): Promise<PageState> {
  const point = await browser.execute((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }, selector);
  await browser
    .action("wheel")
    .scroll({ x: point.x, y: point.y, deltaX: 0, deltaY: 1200, duration: 100 })
    .perform();
  let state: PageState | null = null;
  let last = -1;
  await browser.waitUntil(
    async () => {
      state = await pageState(true);
      const settled = state !== null && state.top > from + 2 && state.scrollY === last;
      last = state?.scrollY ?? -1;
      return settled;
    },
    { timeout: 5000, interval: 200, timeoutMsg: "the reader's wheel did not scroll the page" },
  );
  return state!;
}

/** Scrolls the active tab's split view's source to show line `number` at its top. */
async function scrollSourceToLine(number: number): Promise<void> {
  await browser.execute(
    (active, number) => {
      const source = document.querySelector<HTMLElement>(
        `${active} .html-page-viewer__split .html-page-viewer__source`,
      );
      const line = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[
        number - 1
      ];
      if (!source || !line) throw new Error(`No line ${number}`);
      source.scrollTop = line.offsetTop;
    },
    ACTIVE,
    number,
  );
}

/**
 * Opens the long page in the active tab's split view, with its source at line
 * 20 and its page following it to paragraph 12. In the long page, paragraph N
 * is on line 8 + N of the source.
 */
async function openLongPageSplit(): Promise<void> {
  await openInActiveTab("Saved/Long page.html");
  await clickToolbarButton("Split");
  await waitForPage();
  await scrollSourceToLine(20);
  await browser.waitUntil(async () => Math.abs(((await pageState(false))?.top ?? 0) - 12) <= 1, {
    timeout: 5000,
    timeoutMsg: "the page did not follow the source to paragraph 12",
  });
}

/**
 * When scrollSourceInMove gives the reader's input in the split view's source,
 * and when it scrolls the source: once the frame has dropped the page's
 * document, before the view shows the next one ("before shown"), or in the
 * task in which the view places the frame's next document where the previous
 * one was, once it has done so ("placed").
 */
const MOVE_MOMENTS = {
  "before shown": { input: "before shown", scroll: "before shown" },
  placed: { input: "placed", scroll: "placed" },
  "input before shown": { input: "before shown", scroll: "placed" },
} as const;
type MoveMoment = keyof typeof MOVE_MOMENTS;

/**
 * What scrollSourceInMove did: for its input and its scroll, how far the moved
 * page was scrolled down then, or null before the frame had its next page.
 */
interface SourceInMove {
  input?: number | null;
  scroll?: number | null;
}

/**
 * Scrolls the active tab's split view's source to line 30 in the move that
 * moveActiveTab makes next, as the reader does: with a wheel event in the
 * source, and its scrollTop, each at the moment that MOVE_MOMENTS gives. A
 * wheel turned through WebDriver cannot be timed to a moment of a move. In
 * the task that places the page, the source and the page report their
 * scrolling in the same animation frame, where Chromium reports the
 * source's, in Obsidian's window, first. With the input before the page shows
 * and the scroll only after it is placed, the source scrolls as with keys or
 * the scroll bar, whose scrolling Chromium reports after the input.
 */
async function scrollSourceInMove(when: MoveMoment): Promise<void> {
  await browser.execute(
    (active, moments) => {
      const source = document.querySelector<HTMLElement>(
        `${active} .html-page-viewer__split .html-page-viewer__source`,
      )!;
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      )!;
      const line = source.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[29];
      const old = frame.contentDocument!;
      const result: { input?: number | null; scroll?: number | null } = {};
      (window as unknown as { e2eSourceInMove: typeof result }).e2eSourceInMove = result;
      const pageY = (): number | null => {
        const doc = frame.contentDocument;
        return doc && doc !== old && doc.URL === "about:srcdoc" ? doc.defaultView!.scrollY : null;
      };
      const act = (moment: "before shown" | "placed"): void => {
        if (moments.input === moment && result.input === undefined) {
          result.input = pageY();
          source.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
        }
        if (moments.scroll === moment && result.scroll === undefined) {
          result.scroll = pageY();
          source.scrollTop = line.offsetTop;
        }
      };
      let dropped = false;
      old.defaultView!.addEventListener("pagehide", () => {
        dropped = true;
      });
      // The frame's next documents can share one window: the one of the
      // empty document that the frame starts with when Obsidian inserts it.
      const watched = new WeakSet<Window>();
      const watch = (): void => {
        const win = frame.contentDocument?.defaultView;
        if (!win || watched.has(win) || frame.contentDocument === old) return;
        watched.add(win);
        // After the task that moved the tab, as the reader's input is.
        window.setTimeout(() => act("before shown"), 0);
        const scrollTo = win.scrollTo.bind(win) as (options: ScrollToOptions) => void;
        win.scrollTo = ((options: ScrollToOptions) => {
          scrollTo(options);
          if (win.document.URL === "about:srcdoc" && win.scrollY > 0)
            queueMicrotask(() => act("placed"));
        }) as typeof win.scrollTo;
      };
      const channel = new MessageChannel();
      const until = performance.now() + 10_000;
      channel.port1.onmessage = () => {
        if (dropped) watch();
        if (result.scroll === undefined && performance.now() < until)
          channel.port2.postMessage(null);
      };
      channel.port2.postMessage(null);
    },
    ACTIVE,
    MOVE_MOMENTS[when],
  );
}

/** What scrollSourceInMove did. */
async function scrolledSourceInMove(): Promise<SourceInMove> {
  return browser.execute(
    () => (window as unknown as { e2eSourceInMove: SourceInMove }).e2eSourceInMove,
  );
}

/**
 * Moves the active tab's page, scrolled to paragraph 30 of HELD, to another
 * tab group while its image is held, so that it has its text again long
 * before it loads. The reader then turns the wheel over `selector`, and only
 * then does the image fail, which lets the page load. Returns what the moved
 * page showed after the reader's scrolling, and once it had loaded.
 */
async function scrollBeforeLoad(
  selector: string,
  split: boolean,
): Promise<{ scrolled: PageState; loaded: PageState }> {
  const image = await heldImage();
  try {
    await writeParagraphsPage(
      HELD,
      `<img src="${image.url}" alt="An image that arrives only when the test says" width="16" height="16">\n`,
    );
    await openInActiveTab(HELD);
    if (split) await clickToolbarButton("Split");
    await waitForParsedPage();
    await scrollToParagraph(30, 0.5);
    expect(await pageState(false)).toMatchObject({ top: 30 });

    await moveActiveTab("group");
    await waitForMovedPage(
      (state) => state.readyState === "interactive" && state.top === 30,
      "its page at paragraph 30 before it loaded",
    );
    const scrolled = await wheelDown(selector, 30);
    expect(scrolled.readyState).toBe("interactive");

    image.release();
    await waitForMovedPage();
    await nextFrames();
    return { scrolled, loaded: (await pageState(true))! };
  } finally {
    image.close();
  }
}

/** Scrolls the active tab's page to show `fraction` of paragraph `number`'s height above its top. */
async function scrollToParagraph(number: number, fraction: number): Promise<void> {
  await scrollToElement(`p${number}`, fraction);
}

/** Scrolls the active tab's page to show `fraction` of element `id`'s height above its top. */
async function scrollToElement(id: string, fraction: number): Promise<void> {
  await browser.execute(
    (active, id, fraction) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      );
      const doc = frame?.contentDocument;
      const element = doc?.getElementById(id);
      if (!doc?.defaultView || !element) throw new Error(`No element ${id}`);
      const box = element.getBoundingClientRect();
      doc.defaultView.scrollTo(0, doc.defaultView.scrollY + box.top + fraction * box.height);
    },
    ACTIVE,
    id,
    fraction,
  );
}

/**
 * A page with two parts that the reader opens: a `<details>` element, and an
 * accordion, as CSS-only pages make them, whose checkbox lifts the height
 * limit that keeps its panel closed.
 */
const CLOSED_PARTS = "Saved/Closed parts.html";

async function writeClosedPartsPage(): Promise<void> {
  await writePage(
    CLOSED_PARTS,
    "Closed parts",
    `<style>
.panel { max-height: 0; overflow: hidden; }
#accordion-open:checked ~ .panel { max-height: none; }
</style>
`,
    `${paragraphs(1, 5)}
<details id="details"><summary>Details</summary>
${paragraphs(1, 8, "d", "Inside the details")}
</details>
${paragraphs(6, 5)}
<div id="accordion"><input type="checkbox" id="accordion-open"><label for="accordion-open">Accordion</label>
<div class="panel" id="accordion-panel">
${paragraphs(1, 8, "a", "Inside the accordion")}
</div>
</div>
${paragraphs(11, 50)}
`,
  );
}

/**
 * Where the element `id` is in the window of the page that moveActiveTab
 * moved, how far that page is scrolled, and whether its parts are open.
 */
async function movedClosedParts(
  id: string,
): Promise<{ top: number; scrollY: number; details: boolean; accordion: boolean } | null> {
  return browser.executeObsidian(({ app }, id) => {
    const docs: Document[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const doc =
        leaf.view.containerEl.querySelector<HTMLIFrameElement>(
          "iframe[data-e2e-moved]",
        )?.contentDocument;
      if (doc) docs.push(doc);
    });
    const doc = docs[0];
    const element = doc?.getElementById(id);
    if (!doc?.defaultView || !element) return null;
    return {
      top: element.getBoundingClientRect().top,
      scrollY: doc.defaultView.scrollY,
      details: doc.querySelector("details")!.open,
      accordion: doc.querySelector<HTMLInputElement>("#accordion-open")!.checked,
    };
  }, id);
}

/**
 * How far the source that a test marked with `data-e2e-moved` is scrolled
 * down, in whichever window it is.
 */
async function movedSource(): Promise<{ top: number; inWindow: boolean } | null> {
  return browser.executeObsidian(({ app }) => {
    const found: { top: number; inWindow: boolean }[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const source = leaf.view.containerEl.querySelector<HTMLElement>(
        ".html-page-viewer__source[data-e2e-moved]",
      );
      if (source)
        found.push({ top: source.scrollTop, inWindow: source.ownerDocument !== document });
    });
    return found[0] ?? null;
  });
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
    await writeParagraphsPage();
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
    await writeParagraphsPage();
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

  // The frame's new document shows the part closed, as the page's copy has
  // it. Chromium keeps a closed <details> element's content laid out, so that
  // it still reports a box there; the accordion's content keeps its own box
  // and height too, inside a panel that clips it to none. The <details>
  // element comes to the top with its summary, the panel where its content
  // would begin, below its label.
  for (const [part, inside, top] of [
    ["details", "d6", "details"],
    ["accordion", "a6", "accordion-panel"],
  ] as const) {
    it(`shows the ${part} that its page was inside, closed again, at the window's top`, async function () {
      await writeClosedPartsPage();
      await openInActiveTab(CLOSED_PARTS);
      await waitForPage();
      await browser.execute(
        (active, part) => {
          const doc = document.querySelector<HTMLIFrameElement>(
            `${active} iframe.html-page-viewer__frame`,
          )!.contentDocument!;
          if (part === "details") doc.querySelector("details")!.open = true;
          else doc.querySelector<HTMLInputElement>("#accordion-open")!.checked = true;
        },
        ACTIVE,
        part,
      );
      await scrollToElement(inside, 0.5);
      const before = await browser.execute(
        (active, inside) => {
          const doc = document.querySelector<HTMLIFrameElement>(
            `${active} iframe.html-page-viewer__frame`,
          )!.contentDocument!;
          const box = doc.getElementById(inside)!.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom };
        },
        ACTIVE,
        inside,
      );
      expect(before.top).toBeLessThan(0);
      expect(before.bottom).toBeGreaterThan(0);

      await moveActiveTab("group");
      await waitForMovedPage();
      const after = await movedClosedParts(top);
      expect(after).not.toBeNull();
      expect(after!.details || after!.accordion).toBe(false);
      expect(after!.scrollY).toBeGreaterThan(0);
      expect(after!.top).toBeGreaterThanOrEqual(-1);
      expect(after!.top).toBeLessThanOrEqual(1);
    });
  }

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
    await openLongPageSplit();

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
    // On 1.5.3, the source follows the placed page an animation frame later;
    // 1.15.1 scrolls it back itself while it moves the tab.
    const after = await waitForMovedPage(
      (state) =>
        state.readyState === "complete" &&
        Math.abs(state.top - 12) <= 1 &&
        Math.abs((state.line ?? 0) - 20) <= 1,
      "its page at paragraph 12 and its source at line 20",
    );
    expect(Math.abs(after.top - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs((after.line ?? 0) - 20)).toBeLessThanOrEqual(1);

    // Line 30 is paragraph 22's. The view follows it whenever it comes after
    // the move, also before it has followed the placed page.
    await scrollSourceToLine(30);
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

  for (const [when, what] of [
    ["placed", "in the animation frame in which it places the moved page"],
    ["before shown", "before it shows the moved page again"],
    ["input before shown", "that starts before it shows the moved page again"],
  ] as const) {
    it(`follows the reader's scrolling of the split view's source ${what} (#157)`, async function () {
      await openLongPageSplit();
      await nextFrames();

      await scrollSourceInMove(when);
      await moveActiveTab("group");
      const after = await waitForMovedPage(
        (state) =>
          state.readyState === "complete" &&
          Math.abs(state.top - 22) <= 1 &&
          Math.abs((state.line ?? 0) - 30) <= 1,
        "its page following its source to paragraph 22 and line 30",
      );
      expect(after.inWindow).toBe(false);
      // The input and the scroll came at the moments that the test is about:
      // before the view placed the page, or once it had.
      const done = await scrolledSourceInMove();
      const moments = MOVE_MOMENTS[when];
      for (const [what, at] of [
        [done.input, moments.input],
        [done.scroll, moments.scroll],
      ] as const) {
        expect(what).not.toBeUndefined();
        if (at === "placed") expect(what).toBeGreaterThan(0);
        else expect(what ?? 0).toBe(0);
      }

      // Nothing sends either side back afterwards.
      await nextFrames();
      const settled = (await pageState(true))!;
      expect(Math.abs(settled.top - 22)).toBeLessThanOrEqual(1);
      expect(Math.abs((settled.line ?? 0) - 30)).toBeLessThanOrEqual(1);
    });
  }

  // The view finds in the split view's source again when the frame's next
  // document comes, which scrolls the source to the current match. That is
  // not the reader's scrolling: the placed page leads.
  it("keeps the split view's sides in place when the find bar finds in its source again after the move (#157)", async function () {
    await openLongPageSplit();
    await browser.$(`${ACTIVE} .html-page-viewer__split .html-page-viewer__source`).click();
    await browser.keys(["Control", "f"]);
    await browser.$(`${ACTIVE} .html-page-viewer__find input`).setValue("Paragraph 45 of");
    await browser.keys("Enter");
    // Paragraph 45 is on line 53, which the find bar brings to the source's middle.
    await browser.waitUntil(async () => ((await pageState(false))?.line ?? 0) > 30, {
      timeout: 5000,
      timeoutMsg: "the find bar did not scroll the source to paragraph 45's line",
    });
    await scrollSourceToLine(20);
    await browser.waitUntil(async () => Math.abs(((await pageState(false))?.top ?? 0) - 12) <= 1, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the source back to paragraph 12",
    });
    await nextFrames();

    await moveActiveTab("group");
    await waitForMovedPage(
      (state) =>
        state.readyState === "complete" &&
        Math.abs(state.top - 12) <= 1 &&
        Math.abs((state.line ?? 0) - 20) <= 1,
      "its page at paragraph 12 and its source at line 20",
    );
    await nextFrames();
    const settled = (await pageState(true))!;
    expect(Math.abs(settled.top - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs((settled.line ?? 0) - 20)).toBeLessThanOrEqual(1);
  });

  // Chromium shows an element that Obsidian took out of the page and inserted
  // again from its top. Obsidian 1.15.1 scrolls it back itself; on 1.5.3 the
  // view does, after the layout change in another tab group, and once a new
  // window has laid the source out, when Obsidian resizes the view.
  for (const to of ["group", "window"] as const) {
    it(`keeps the source view's place in ${to === "group" ? "another tab group" : "a new window"} (#135)`, async function () {
      await openInActiveTab("Saved/Long page.html");
      await clickToolbarButton("Source");
      const before = await browser.execute((active) => {
        const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!;
        source.dataset.e2eMoved = "";
        source.scrollTop = source.scrollHeight - source.clientHeight - 30;
        return source.scrollTop;
      }, ACTIVE);
      expect(before).toBeGreaterThan(300);
      // The view learns where the source is from its scroll event.
      await nextFrames();

      await moveActiveTab(to);
      let after: { top: number; inWindow: boolean } | null = null;
      try {
        await browser.waitUntil(
          async () => {
            after = await movedSource();
            return after !== null && Math.abs(after.top - before) <= 1;
          },
          { timeout: 5000 },
        );
      } catch {
        throw new Error(`The moved source did not go back to ${before}: ${JSON.stringify(after)}`);
      }
      expect(after!.inWindow).toBe(to === "window");
      await browser.pause(500);
      expect(Math.abs((await movedSource())!.top - before)).toBeLessThanOrEqual(1);
    });
  }

  it("leaves its page where the reader scrolls it before the page has loaded", async function () {
    const { scrolled, loaded } = await scrollBeforeLoad("iframe[data-e2e-moved]", false);
    expect(loaded.readyState).toBe("complete");
    expect(loaded.top).toBe(scrolled.top);
  });

  it("leaves both sides of the split view where the reader scrolls its source before the page has loaded", async function () {
    const { scrolled, loaded } = await scrollBeforeLoad(
      `${ACTIVE} .html-page-viewer__split .html-page-viewer__source`,
      true,
    );
    expect(loaded.readyState).toBe("complete");
    expect(loaded.top).toBe(scrolled.top);
    expect(Math.abs((loaded.line ?? 0) - (scrolled.line ?? 0))).toBeLessThanOrEqual(1);
  });
});
