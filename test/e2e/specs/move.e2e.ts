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
  /** How far the page is scrolled down, and sideways, in CSS pixels. */
  scrollY: number;
  scrollX: number;
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
      scrollX: win.scrollX,
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
 * A reader's scrolling of the split view's source in a move: an input in the
 * source, a wheel turn or a pointer press, and then, unless `scroll` is null,
 * a scroll of the source to line 30, to its start, or down by 200 pixels
 * from where it is,
 * as a wheel scrolls. Each comes at one of two moments: in the first task
 * after the frame drops the page's document, before the view shows the next
 * one ("before shown"), or in the task in which the view places the frame's
 * next document where the previous one was, once it has done so ("placed").
 */
interface ReaderInMove {
  readonly input: "wheel" | "pointerdown";
  readonly inputAt: "before shown" | "placed";
  readonly scroll: "to line 30" | "to its start" | "down 200" | null;
  readonly scrollAt: "before shown" | "placed";
}

/**
 * What scrollSourceInMove did: for its input and its scroll, how far the moved
 * page was scrolled down then, or null before the frame had its next page.
 */
interface SourceInMove {
  input?: number | null;
  scroll?: number | null;
}

/**
 * Scrolls the active tab's split view's source in the move that moveActiveTab
 * makes next, as `reader` says. The input is a dispatched event, and the
 * scroll sets the source's scrollTop: a wheel turned through WebDriver cannot
 * be timed to a moment of a move. In the task that places the page, the
 * source and the page report their scrolling in the same animation frame,
 * where Chromium reports the source's, in Obsidian's window, first. With the
 * input before the page shows and the scroll only after it is placed, the
 * source scrolls as with keys or the scroll bar, whose scrolling Chromium
 * reports after the input.
 */
async function scrollSourceInMove(reader: ReaderInMove): Promise<void> {
  await browser.execute(
    (active, reader) => {
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
        if (reader.inputAt === moment && result.input === undefined) {
          result.input = pageY();
          const init = { bubbles: true, cancelable: true };
          source.dispatchEvent(
            reader.input === "wheel"
              ? new WheelEvent("wheel", { ...init, deltaY: 200 })
              : new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }),
          );
        }
        if (reader.scroll !== null && reader.scrollAt === moment && result.scroll === undefined) {
          result.scroll = pageY();
          if (reader.scroll === "to line 30") source.scrollTop = line.offsetTop;
          else if (reader.scroll === "to its start") source.scrollTop = 0;
          else source.scrollTop += 200;
        }
      };
      let dropped = false;
      old.defaultView!.addEventListener("pagehide", () => {
        dropped = true;
        // After the task that moved the tab, as the reader's input is.
        window.setTimeout(() => act("before shown"), 0);
      });
      // The frame's next documents can share one window: the one of the
      // empty document that the frame starts with when Obsidian inserts it.
      const watched = new WeakSet<Window>();
      const watch = (): void => {
        const win = frame.contentDocument?.defaultView;
        if (!win || watched.has(win) || frame.contentDocument === old) return;
        watched.add(win);
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
        if (performance.now() < until) channel.port2.postMessage(null);
      };
      channel.port2.postMessage(null);
    },
    ACTIVE,
    reader,
  );
}

/**
 * Checks that scrollSourceInMove's input and scroll came at the moments that
 * `reader` gives: before the view placed the moved page, or once it had.
 */
async function expectMoments(reader: ReaderInMove): Promise<void> {
  const done = await browser.execute(
    () => (window as unknown as { e2eSourceInMove: SourceInMove }).e2eSourceInMove,
  );
  const moments: [number | null | undefined, ReaderInMove["inputAt"]][] = [
    [done.input, reader.inputAt],
  ];
  if (reader.scroll !== null) moments.push([done.scroll, reader.scrollAt]);
  for (const [pageY, at] of moments) {
    expect(pageY).not.toBeUndefined();
    if (at === "placed") expect(pageY).toBeGreaterThan(0);
    else expect(pageY ?? 0).toBe(0);
  }
}

/**
 * Scrolls the active tab's source to its start in one task, as the reader
 * does with the wheel, and has Obsidian send `trigger` before Chromium
 * reports the scroll in its next frame: a layout change, or a resize of the
 * view. Then waits for two frames.
 */
async function scrollSourceToStartBefore(trigger: "layout-change" | "resize"): Promise<void> {
  await browser.executeObsidian(({ app }, trigger) => {
    const leaf = app.workspace.getMostRecentLeaf()!;
    const source = leaf.view.containerEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
    source.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -2000 }),
    );
    source.scrollTop = 0;
    if (trigger === "resize") (leaf.view as unknown as { onResize(): void }).onResize();
    else app.workspace.trigger("layout-change");
  }, trigger);
  await nextFrames();
  await nextFrames();
}

/** How far the active tab's source is scrolled down. */
async function sourceTop(): Promise<number> {
  return browser.execute(
    (active) =>
      document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!.scrollTop,
    ACTIVE,
  );
}

/**
 * Opens the long page in the split view, as openLongPageSplit does, with the
 * find bar open on paragraph 45, on line 53, and the source scrolled back to
 * line 20 after the find bar brought that line to its middle.
 */
async function openLongPageSplitFinding(): Promise<void> {
  await openLongPageSplit();
  await browser.$(`${ACTIVE} .html-page-viewer__split .html-page-viewer__source`).click();
  await browser.keys(["Control", "f"]);
  await browser.$(`${ACTIVE} .html-page-viewer__find input`).setValue("Paragraph 45 of");
  await browser.keys("Enter");
  await browser.waitUntil(async () => ((await pageState(false))?.line ?? 0) > 30, {
    timeout: 5000,
    timeoutMsg: "the find bar did not scroll the source to paragraph 45's line",
  });
  await scrollSourceToLine(20);
  await browser.waitUntil(async () => Math.abs(((await pageState(false))?.top ?? 0) - 12) <= 1, {
    timeout: 5000,
    timeoutMsg: "the page did not follow the source back to paragraph 12",
  });
}

/**
 * Waits until the moved tab's page has loaded with its source at line `line`
 * and its page following it, and checks that nothing moves either side
 * afterwards. In the long page, paragraph N is on line 8 + N.
 */
async function expectMovedSplitAt(line: number, what: string): Promise<void> {
  await waitForMovedPage(
    (state) =>
      state.readyState === "complete" &&
      Math.abs((state.line ?? 0) - line) <= 1 &&
      Math.abs(state.top - (line - 8)) <= 1,
    what,
  );
  await nextFrames();
  const settled = (await pageState(true))!;
  expect(Math.abs((settled.line ?? 0) - line)).toBeLessThanOrEqual(1);
  expect(Math.abs(settled.top - (line - 8))).toBeLessThanOrEqual(1);
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

/** The split view's source of the tab that moveActiveTab moved, with line `number`. */
interface MovedSplitSource {
  /** How far the source is scrolled down, and how far down line `number` is in it. */
  scrollTop: number;
  lineTop: number;
  /** The font and the line height that the window's styles give the source's lines. */
  font: string;
  lineHeight: string;
}

/** The split view's source of the tab that moveActiveTab moved, in whichever window it is. */
async function movedSplitSource(number: number): Promise<MovedSplitSource | null> {
  return browser.executeObsidian(({ app }, number) => {
    const found: MovedSplitSource[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const source = leaf.view.containerEl
        .querySelector("iframe[data-e2e-moved]")
        ?.closest(".html-page-viewer__split")
        ?.querySelector<HTMLElement>(".html-page-viewer__source");
      const line = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[
        number - 1
      ];
      const pre = source?.querySelector("pre");
      if (!source || !line || !pre) return;
      const style = source.ownerDocument.defaultView!.getComputedStyle(pre);
      found.push({
        scrollTop: source.scrollTop,
        lineTop: line.offsetTop,
        font: style.fontFamily,
        lineHeight: style.lineHeight,
      });
    });
    return found[0] ?? null;
  }, number);
}

/** What holdNewWindowStyles did. */
interface HeldStyles {
  /** Whether it held back the new window's app.css, and let it apply again. */
  held: boolean;
  released: boolean;
  /**
   * Whether the view had put the source at the line, laid out without
   * app.css, and with a reader, whether the page had followed their scroll of
   * the source, when app.css applied again.
   */
  followed: boolean;
  read: boolean;
  /** How far down the page was when app.css applied again, after the reader's scroll. */
  pageY: number | null;
}

/** A reader's scroll of the split view's source to `line`, which paragraph `paragraph` is on. */
interface ReaderLine {
  readonly line: number;
  readonly paragraph: number;
}

/**
 * Has the next window that Obsidian opens lay its elements out without
 * Obsidian's app.css until the split view's source of the tab that
 * moveActiveTab moves there shows line `number` at its top, as the view's
 * following of the page puts it. With `reader`, the reader then turns the
 * wheel over the source and scrolls it to their line, and app.css waits
 * until the page has followed. Then app.css applies, in the window's next
 * frame. Obsidian opens a new window with `window.open` and then adds its
 * styles; on Obsidian 1.5.3, app.css can arrive there after the view has put
 * the sides in step (#165). restoreWindowOpen ends the wrap of `window.open`
 * if no window opened. With `sourceView`, it holds app.css back until the
 * **Source** view's source shows the line, as the view puts it back (#189).
 */
async function holdNewWindowStyles(
  number: number,
  reader?: ReaderLine,
  sourceView = false,
): Promise<void> {
  await browser.execute(
    (number, reader, sourceView) => {
      const state: HeldStyles = {
        held: false,
        released: false,
        followed: false,
        read: false,
        pageY: null,
      };
      const main = window as unknown as {
        e2eHeldStyles: HeldStyles;
        e2eWindowOpen?: typeof window.open;
      };
      main.e2eHeldStyles = state;
      const open = window.open;
      main.e2eWindowOpen = open;
      window.open = function (this: Window, ...args: Parameters<typeof window.open>) {
        window.open = open;
        delete main.e2eWindowOpen;
        const win = open.apply(this, args) as (Window & typeof globalThis) | null;
        if (!win) return win;
        const release = (link: Element): void => {
          const until = performance.now() + 10_000;
          let scrolled = false;
          const check = (): void => {
            const source = win.document.querySelector<HTMLElement>(
              sourceView
                ? ".html-page-viewer__source"
                : ".html-page-viewer__split .html-page-viewer__source",
            );
            const lines = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line");
            const doc =
              win.document.querySelector<HTMLIFrameElement>(
                "iframe[data-e2e-moved]",
              )?.contentDocument;
            // The frame's next document has its URL before its root element.
            const root = doc?.URL === "about:srcdoc" ? doc.documentElement : null;
            const at = (number: number): boolean => {
              const line = lines?.[number - 1];
              return (
                source !== null &&
                line !== undefined &&
                source.scrollTop > 0 &&
                Math.abs(source.scrollTop - line.offsetTop) <= 2
              );
            };
            if (!state.followed)
              state.followed =
                (sourceView || (root !== null && root.dataset.e2eBefore === undefined)) &&
                at(number);
            if (state.followed && reader && !state.read) {
              if (!scrolled) {
                scrolled = true;
                // In a task, as the reader's wheel is, which Chromium reports
                // before the next frame's callbacks, such as the view's
                // following of the page that it placed at `load`.
                win.setTimeout(() => {
                  source!.dispatchEvent(
                    new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }),
                  );
                  source!.scrollTop = lines![reader.line - 1].offsetTop;
                }, 0);
              } else {
                const shown = [...doc!.querySelectorAll("p")].find(
                  (paragraph) => paragraph.getBoundingClientRect().bottom > 1,
                );
                const paragraph = Number(/Paragraph (\d+)/.exec(shown?.textContent ?? "")?.[1]);
                state.read = paragraph === reader.paragraph && at(reader.line);
                if (state.read) state.pageY = doc!.defaultView!.scrollY;
              }
            }
            const done = state.followed && (!reader || state.read);
            if (!done && performance.now() < until) {
              win.requestAnimationFrame(check);
              return;
            }
            link.removeAttribute("media");
            state.released = true;
          };
          win.requestAnimationFrame(check);
        };
        // Before the window's next layout: a mutation observer runs once the
        // script that adds the link has.
        new win.MutationObserver((records, observer) => {
          for (const record of records)
            for (const node of record.addedNodes) {
              if (node.nodeName !== "LINK" || (node as Element).getAttribute("href") !== "app.css")
                continue;
              observer.disconnect();
              (node as Element).setAttribute("media", "not all");
              state.held = true;
              release(node as Element);
              return;
            }
        }).observe(win.document, { childList: true, subtree: true });
        return win;
      } as typeof window.open;
    },
    number,
    reader ?? null,
    sourceView,
  );
}

/** Ends holdNewWindowStyles' wrap of `window.open`, where no window has opened since. */
async function restoreWindowOpen(): Promise<void> {
  await browser.execute(() => {
    const main = window as unknown as { e2eWindowOpen?: typeof window.open };
    if (main.e2eWindowOpen) window.open = main.e2eWindowOpen;
    delete main.e2eWindowOpen;
  });
}

/**
 * Moves the active tab to a new window with moveActiveTab, holding the new
 * window's app.css back as holdNewWindowStyles does, and says what it did.
 */
async function moveToWindowHoldingStyles(number: number, sourceView = false): Promise<HeldStyles> {
  await holdNewWindowStyles(number, undefined, sourceView);
  try {
    await moveActiveTab("window");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => (window as unknown as { e2eHeldStyles: HeldStyles }).e2eHeldStyles.released,
        )) === true,
      { timeout: 15_000, timeoutMsg: "the new window's app.css was not held back and let go" },
    );
    return await browser.execute(
      () => (window as unknown as { e2eHeldStyles: HeldStyles }).e2eHeldStyles,
    );
  } finally {
    await restoreWindowOpen();
  }
}

/** Waits for two animation frames of the window that the tab moveActiveTab moved is in. */
async function nextMovedFrames(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const windows: Window[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const win =
        leaf.view.containerEl.querySelector("iframe[data-e2e-moved]")?.ownerDocument.defaultView;
      if (win) windows.push(win);
    });
    const win = windows[0];
    if (!win) throw new Error("No moved tab");
    await new Promise<void>((resolve) =>
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve())),
    );
  });
}

/**
 * Moves the tab whose source a test marked with `data-e2e-moved` from its
 * window into a tab group of Obsidian's main window, as dragging it there
 * does. The window that it leaves without tabs closes.
 */
async function moveMarkedTabToMainWindow(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    // Not in Obsidian's API types; 1.5.3 and 1.15.1 have them.
    interface Parent {
      children: unknown[];
      removeChild(child: unknown): void;
      insertChild(index: number, child: unknown): void;
      selectTabIndex(index: number): void;
    }
    type Leaf = Parameters<Parameters<typeof app.workspace.iterateAllLeaves>[0]>[0];
    const marked: Leaf[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.containerEl.querySelector(".html-page-viewer__source[data-e2e-moved]"))
        marked.push(leaf);
    });
    const groups: Parent[] = [];
    app.workspace.iterateRootLeaves((leaf) => {
      if (leaf.view.containerEl.ownerDocument === document)
        groups.push((leaf as unknown as { parent: Parent }).parent);
    });
    const leaf = marked[0];
    const group = groups[0];
    if (!leaf || !group) throw new Error("No marked tab, or no tab group in the main window");
    const moved = leaf as unknown as { parent: Parent; setDimension(size: null): void };
    moved.parent.removeChild(leaf);
    moved.setDimension(null);
    group.insertChild(-1, leaf);
    group.selectTabIndex(group.children.indexOf(leaf));
    app.workspace.setActiveLeaf(leaf, { focus: true });
  });
}

/**
 * Types into the find bar of the tab whose source a test marked with
 * `data-e2e-moved`, in whichever window it is: each of `texts` in turn, 30 ms
 * apart, as keys typed one after another, and then presses Enter `enters`
 * times at once. All of it comes within the bar's delay before it searches
 * what was typed.
 */
async function typeIntoMovedFind(texts: readonly string[], enters: number): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, texts, enters) => {
      const inputs: HTMLInputElement[] = [];
      app.workspace.iterateAllLeaves((leaf) => {
        if (!leaf.view.containerEl.querySelector(".html-page-viewer__source[data-e2e-moved]"))
          return;
        const input = leaf.view.containerEl.querySelector<HTMLInputElement>(
          ".html-page-viewer__find input",
        );
        if (input) inputs.push(input);
      });
      const input = inputs[0];
      if (!input) throw new Error("No find bar in the marked tab");
      for (const text of texts) {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      for (let press = 0; press < enters; press += 1)
        input.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
    },
    texts,
    enters,
  );
}

/** The find bar of the tab whose source a test marked with `data-e2e-moved`. */
interface MovedFind {
  /** What the bar's count says. */
  count: string | null;
  /** How far the source is scrolled down. */
  top: number;
  inWindow: boolean;
  /**
   * How many ranges of the highlights of every match, and of the current
   * one, in the window that shows the source, are in the source and show
   * there: not collapsed, and with a box.
   */
  matches: number;
  current: number;
  /** Whether the source shows the current match, within its height. */
  currentShown: boolean;
  /** How many ranges the highlight of every match holds in Obsidian's main window. */
  inMain: number;
}

/** The find bar of the tab whose source a test marked, in whichever window it is. */
async function movedFind(): Promise<MovedFind | null> {
  return browser.executeObsidian(({ app }) => {
    const found: MovedFind[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const source = leaf.view.containerEl.querySelector<HTMLElement>(
        ".html-page-viewer__source[data-e2e-moved]",
      );
      if (!source) return;
      type Highlights = Map<string, Set<Range>>;
      const registry = (win: Window | null): Highlights =>
        (win as unknown as { CSS: { highlights: Highlights } }).CSS.highlights;
      const showing = (name: string): Range[] =>
        [...(registry(source.ownerDocument.defaultView).get(name) ?? [])].filter(
          (range) =>
            source.contains(range.startContainer) &&
            !range.collapsed &&
            range.getBoundingClientRect().height > 0,
        );
      const current = showing("html-page-viewer-current")[0];
      const box = current?.getBoundingClientRect();
      const frame = source.getBoundingClientRect();
      found.push({
        count:
          leaf.view.containerEl.querySelector(".html-page-viewer__find-count")?.textContent ?? null,
        top: source.scrollTop,
        inWindow: source.ownerDocument !== document,
        matches: showing("html-page-viewer-match").length,
        current: showing("html-page-viewer-current").length,
        currentShown: box !== undefined && box.top >= frame.top && box.bottom <= frame.bottom,
        inMain: registry(window).get("html-page-viewer-match")?.size ?? 0,
      });
    });
    return found[0] ?? null;
  });
}

/**
 * Has the active tab's find bar find `text` in one task, as Enter does, and
 * has Obsidian send `trigger` in that task, before Chromium reports the find
 * bar's scroll of the source in its next frame: a layout change, or a resize
 * of the view. Then waits for two frames.
 */
async function findBefore(text: string, trigger: "layout-change" | "resize"): Promise<void> {
  await browser.executeObsidian(
    ({ app }, text, trigger) => {
      const leaf = app.workspace.getMostRecentLeaf()!;
      const input = leaf.view.containerEl.querySelector<HTMLInputElement>(
        ".html-page-viewer__find input",
      )!;
      input.value = text;
      input.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
      if (trigger === "resize") (leaf.view as unknown as { onResize(): void }).onResize();
      else app.workspace.trigger("layout-change");
    },
    text,
    trigger,
  );
  await nextFrames();
  await nextFrames();
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

/** Closes every tab but a new empty one in the main window, which becomes the active tab. */
async function freshTab(): Promise<void> {
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
}

describe("A tab moved to another tab group or window in Obsidian", function () {
  beforeEach(freshTab);

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

  for (const [what, reader] of [
    [
      "in the animation frame in which it places the moved page",
      { input: "wheel", inputAt: "placed", scroll: "to line 30", scrollAt: "placed" },
    ],
    [
      "before it shows the moved page again",
      { input: "wheel", inputAt: "before shown", scroll: "to line 30", scrollAt: "before shown" },
    ],
    [
      "that starts before it shows the moved page again",
      { input: "wheel", inputAt: "before shown", scroll: "to line 30", scrollAt: "placed" },
    ],
  ] as const) {
    it(`follows the reader's scrolling of the split view's source ${what} (#157)`, async function () {
      await openLongPageSplit();
      await nextFrames();
      await scrollSourceInMove(reader);
      await moveActiveTab("group");
      await expectMovedSplitAt(30, "its page following its source to paragraph 22 and line 30");
      await expectMoments(reader);
    });
  }

  // A wheel scrolls the source on from where it is. Obsidian 1.5.3 shows the
  // moved source from its top, where the view puts it back as the move ends.
  it("follows the reader's scrolling of the split view's source on from its place, before it shows the moved page again (#157)", async function () {
    await openLongPageSplit();
    await nextFrames();
    const reader = {
      input: "wheel",
      inputAt: "before shown",
      scroll: "down 200",
      scrollAt: "before shown",
    } as const;
    await scrollSourceInMove(reader);
    await moveActiveTab("group");
    // 200 pixels are more than 9 of the source's lines.
    await waitForMovedPage(
      (state) => state.readyState === "complete" && (state.line ?? 0) >= 29,
      "its source scrolled on from line 20",
    );
    await nextFrames();
    const settled = (await pageState(true))!;
    expect(settled.line).toBeGreaterThanOrEqual(29);
    expect(settled.line).toBeLessThanOrEqual(32);
    expect(Math.abs(settled.top - (settled.line! - 8))).toBeLessThanOrEqual(1);
    await expectMoments(reader);
  });

  // After a move, the find bar shows its matches again in the split view's
  // source without scrolling it to the current one: that would take both
  // sides away from their place, or from the reader's scrolling.
  it("keeps the split view's sides in place when the find bar finds in its source again after the move (#157)", async function () {
    await openLongPageSplitFinding();
    await nextFrames();
    await moveActiveTab("group");
    await expectMovedSplitAt(20, "its page at paragraph 12 and its source at line 20");
  });

  for (const [what, reader, line] of [
    [
      "a pointer press in its source leaves it",
      { input: "pointerdown", inputAt: "before shown", scroll: null, scrollAt: "before shown" },
      20,
    ],
    [
      "the reader scrolls its source",
      { input: "wheel", inputAt: "before shown", scroll: "to line 30", scrollAt: "before shown" },
      30,
    ],
  ] as const) {
    it(`keeps the split view with the find bar open where ${what} before the moved page shows (#157)`, async function () {
      await openLongPageSplitFinding();
      await nextFrames();
      await scrollSourceInMove(reader);
      await moveActiveTab("group");
      await expectMovedSplitAt(line, `its source at line ${line} and its page following it`);
      await expectMoments(reader);
    });
  }

  // The reader's scroll of the source to its start looks like a source that
  // lost its place until Chromium reports it, and the view keeps the place
  // of the split view's and the source view's source for after a move.
  it("follows the reader's scrolling of the split view's source to its start, before it shows the moved page again in a new window (#157)", async function () {
    await openLongPageSplit();
    await nextFrames();
    const reader = {
      input: "wheel",
      inputAt: "before shown",
      scroll: "to its start",
      scrollAt: "before shown",
    } as const;
    await scrollSourceInMove(reader);
    await moveActiveTab("window");
    await waitForMovedPage(
      (state) => state.readyState === "complete" && state.line === 1 && state.scrollY <= 1,
      "its source and its page at their start",
    );
    await nextFrames();
    expect(await pageState(true)).toMatchObject({ inWindow: true, line: 1 });
    expect((await pageState(true))!.scrollY).toBeLessThanOrEqual(1);
    await expectMoments(reader);
  });

  // On Obsidian 1.5.3, a new window can lay the source out before Obsidian's
  // app.css arrives there, and the view puts the sides in step for that
  // layout; the source's lines move up when the styles arrive. The test holds
  // app.css back in every run. On 1.15.1, the source's lines have their
  // height without app.css, so holding it back moves nothing, and the test
  // cannot show a drift there. Where the reader scrolled the source last, the
  // source keeps their line, and the page stays where it followed them.
  for (const [what, reader, line, paragraph] of [
    ["", undefined, 20, 12],
    [", after the reader scrolled its source there", { line: 25, paragraph: 17 }, 25, 17],
  ] as const) {
    it(`keeps the split view's sides in step in a new window once Obsidian's styles arrive there${what} (#165)`, async function () {
      await openLongPageSplit();
      await nextFrames();
      const styled = await browser.execute((active) => {
        const pre = document.querySelector(
          `${active} .html-page-viewer__split .html-page-viewer__source pre`,
        )!;
        const style = getComputedStyle(pre);
        return { font: style.fontFamily, lineHeight: style.lineHeight };
      }, ACTIVE);

      await holdNewWindowStyles(20, reader);
      let held: HeldStyles;
      try {
        await moveActiveTab("window");
        await browser.waitUntil(
          async () =>
            (await browser.execute(
              () => (window as unknown as { e2eHeldStyles: HeldStyles }).e2eHeldStyles.released,
            )) === true,
          { timeout: 15_000, timeoutMsg: "the new window's app.css was not held back and let go" },
        );
        held = await browser.execute(
          () => (window as unknown as { e2eHeldStyles: HeldStyles }).e2eHeldStyles,
        );
      } finally {
        await restoreWindowOpen();
      }
      expect(held).toMatchObject({
        held: true,
        released: true,
        followed: true,
        read: reader !== undefined,
      });
      await browser.waitUntil(
        async () => {
          const source = await movedSplitSource(line);
          return source?.font === styled.font && source.lineHeight === styled.lineHeight;
        },
        { timeout: 10_000, timeoutMsg: "the new window did not get Obsidian's styles" },
      );
      await waitForMovedPage();
      // The view's observer of the source's size, and the sides' following,
      // run in the window's next frames.
      await nextMovedFrames();
      await nextMovedFrames();
      const source = (await movedSplitSource(line))!;
      expect(Math.abs(source.scrollTop - source.lineTop)).toBeLessThanOrEqual(2);
      const page = (await pageState(true))!;
      expect(Math.abs(page.top - paragraph)).toBeLessThanOrEqual(1);
      if (held.pageY !== null) expect(Math.abs(page.scrollY - held.pageY)).toBeLessThanOrEqual(2);
    });
  }

  for (const trigger of ["layout-change", "resize"] as const) {
    const what = trigger === "resize" ? "a resize" : "a layout change";
    it(`leaves the split view's source at its start where the reader scrolls it, when ${what} comes before Chromium reports it (#157)`, async function () {
      await openLongPageSplit();
      await nextFrames();
      await scrollSourceToStartBefore(trigger);
      expect(await sourceTop()).toBe(0);
      await browser.waitUntil(async () => (await pageState(false))?.scrollY === 0, {
        timeout: 5000,
        timeoutMsg: "the page did not follow the source to its start",
      });
    });

    it(`leaves the source view's source at its start where the reader scrolls it, when ${what} comes before Chromium reports it (#157)`, async function () {
      await openInActiveTab("Saved/Long page.html");
      await clickToolbarButton("Source");
      await browser.execute((active) => {
        const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!;
        source.scrollTop = 400;
      }, ACTIVE);
      // The view learns where the source is from its scroll event.
      await nextFrames();
      expect(await sourceTop()).toBe(400);
      await scrollSourceToStartBefore(trigger);
      expect(await sourceTop()).toBe(0);
    });

    // The find bar's scroll of the source is the view's own, not the
    // reader's, and the view keeps where it put the source.
    for (const mode of ["split", "source"] as const) {
      it(`leaves the ${mode} view's source at its start where the find bar scrolls it, when ${what} comes before Chromium reports it (#167)`, async function () {
        if (mode === "split") {
          await openLongPageSplit();
        } else {
          await openInActiveTab("Saved/Long page.html");
          await clickToolbarButton("Source");
        }
        await browser.$(`${ACTIVE} .html-page-viewer__source`).click();
        await browser.keys(["Control", "f"]);
        if (mode === "source")
          await browser.execute((active) => {
            document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!.scrollTop =
              400;
          }, ACTIVE);
        await nextFrames();
        expect(await sourceTop()).toBeGreaterThan(300);
        // Only the source's first line has the text, which the find bar
        // brings to the source's middle, so to its start.
        await findBefore("doctype", trigger);
        expect(await sourceTop()).toBe(0);
        if (mode === "split")
          await browser.waitUntil(async () => (await pageState(false))?.scrollY === 0, {
            timeout: 5000,
            timeoutMsg: "the page did not follow the source to its start",
          });
      });
    }
  }

  // A hotkey or a macro that moves the tab can send its modifier key to the
  // source in the frame of the move. A modifier key scrolls nothing, so the
  // source lost its place, as Obsidian 1.5.3 shows it from its start.
  it("keeps the source view's place in another tab group, when a modifier key in its source comes in the same task as the move (#167)", async function () {
    await openInActiveTab("Saved/Long page.html");
    await clickToolbarButton("Source");
    const before = await browser.execute((active) => {
      const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!;
      source.dataset.e2eMoved = "";
      source.scrollTop = 400;
      return source.scrollTop;
    }, ACTIVE);
    await nextFrames();
    // The calls of moveActiveTab("group"), after the key.
    await browser.executeObsidian(({ app }) => {
      const leaf = app.workspace.getMostRecentLeaf()!;
      leaf.view.containerEl.querySelector(".html-page-viewer__source")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Control",
          ctrlKey: true,
        }),
      );
      interface Parent {
        children: unknown[];
        removeChild(child: unknown): void;
        insertChild(index: number, child: unknown): void;
        selectTabIndex(index: number): void;
      }
      const moved = leaf as unknown as { parent: Parent; setDimension(size: null): void };
      const split = app.workspace.getLeaf("split", "vertical") as unknown as { parent: Parent };
      moved.parent.removeChild(leaf);
      moved.setDimension(null);
      split.parent.insertChild(-1, leaf);
      split.parent.selectTabIndex(split.parent.children.indexOf(leaf));
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
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
    await browser.pause(500);
    expect(Math.abs((await movedSource())!.top - before)).toBeLessThanOrEqual(1);
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

    // Obsidian's move collapses the ranges of the find bar's matches, and a
    // new window paints only its own highlights. The view finds them again,
    // without scrolling the source to the current one.
    it(`shows the source view's find matches again in ${to === "group" ? "another tab group" : "a new window"}, where its source was (#162)`, async function () {
      await openInActiveTab("Saved/Long page.html");
      await clickToolbarButton("Source");
      await browser.$(`${ACTIVE} .html-page-viewer__source`).click();
      await browser.keys(["Control", "f"]);
      // Paragraphs 4 and 40 to 49.
      await browser.$(`${ACTIVE} .html-page-viewer__find input`).setValue("Paragraph 4");
      await browser.keys("Enter");
      const before = await browser.execute((active) => {
        const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!;
        source.dataset.e2eMoved = "";
        source.scrollTop = source.scrollHeight - source.clientHeight - 30;
        return source.scrollTop;
      }, ACTIVE);
      // Paragraph 4 is on line 12, far above where the source is now.
      expect(before).toBeGreaterThan(300);
      await nextFrames();
      expect(await movedFind()).toMatchObject({
        count: "1 of 11",
        matches: 11,
        current: 1,
        currentShown: false,
      });

      await moveActiveTab(to);
      let after: MovedFind | null = null;
      try {
        await browser.waitUntil(
          async () => {
            after = await movedFind();
            return (
              after?.matches === 11 && after.current === 1 && Math.abs(after.top - before) <= 1
            );
          },
          { timeout: 5000 },
        );
      } catch {
        throw new Error(
          `The moved source did not show its matches again: ${JSON.stringify(after)}`,
        );
      }
      await browser.pause(500);
      after = (await movedFind())!;
      expect(after).toMatchObject({ count: "1 of 11", inWindow: to === "window" });
      expect(Math.abs(after.top - before)).toBeLessThanOrEqual(1);
      if (to === "window") expect(after.inMain).toBe(0);

      // Enter goes on to the next match, and shows it.
      await browser.executeObsidian(({ app }) => {
        app.workspace.iterateAllLeaves((leaf) => {
          if (!leaf.view.containerEl.querySelector(".html-page-viewer__source[data-e2e-moved]"))
            return;
          leaf.view.containerEl
            .querySelector(".html-page-viewer__find input")!
            .dispatchEvent(
              new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
            );
        });
      });
      await browser.waitUntil(async () => (await movedFind())?.currentShown === true, {
        timeout: 5000,
        timeoutMsg: "Enter did not show the next match",
      });
      expect(await movedFind()).toMatchObject({ count: "2 of 11", matches: 11, current: 1 });
    });
  }

  // The find bar searches what is typed into it after a short delay, which
  // Enter cancels. The bar here was made in Obsidian's main window.
  it("goes on to the next match when Enter comes before the find bar's delayed search, in a new window (#175)", async function () {
    await openInActiveTab("Saved/Long page.html");
    await clickToolbarButton("Source");
    await browser.$(`${ACTIVE} .html-page-viewer__source`).click();
    await browser.keys(["Control", "f"]);
    await browser.execute((active) => {
      document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!.dataset.e2eMoved =
        "";
    }, ACTIVE);
    await moveActiveTab("window");
    await browser.waitUntil(async () => (await movedFind())?.inWindow === true, {
      timeout: 5000,
      timeoutMsg: "the tab did not move to a new window",
    });

    // Paragraphs 4 and 40 to 49. The first Enter searches, the second goes on.
    await typeIntoMovedFind(["Para", "Paragraph", "Paragraph 4"], 2);
    expect((await movedFind())?.count).toBe("2 of 11");
    await browser.pause(1000);
    expect(await movedFind()).toMatchObject({ count: "2 of 11", current: 1, currentShown: true });
  });

  // The bar here was made in the new window, which closes when its last tab
  // leaves it.
  it("searches what is typed into the find bar after its tab moves back from a new window (#175)", async function () {
    await openInActiveTab("Saved/Long page.html");
    await clickToolbarButton("Source");
    await browser.execute((active) => {
      document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!.dataset.e2eMoved =
        "";
    }, ACTIVE);
    await moveActiveTab("window");
    await browser.waitUntil(async () => (await movedFind())?.inWindow === true, {
      timeout: 5000,
      timeoutMsg: "the tab did not move to a new window",
    });
    await browser.executeObsidian(({ app }) => {
      app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.containerEl.querySelector(".html-page-viewer__source[data-e2e-moved]"))
          (leaf.view as unknown as { openFind(): void }).openFind();
      });
    });
    expect(await movedFind()).toMatchObject({ count: "", inWindow: true });

    await moveMarkedTabToMainWindow();
    await browser.waitUntil(
      async () =>
        (await movedFind())?.inWindow === false &&
        (await browser.executeObsidian(({ app }) => {
          let others = 0;
          app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.containerEl.ownerDocument !== document) others += 1;
          });
          return others;
        })) === 0,
      { timeout: 5000, timeoutMsg: "the tab did not move back to the main window" },
    );

    await typeIntoMovedFind(["Para", "Paragraph", "Paragraph 4"], 0);
    await browser.pause(1000);
    expect(await movedFind()).toMatchObject({ count: "1 of 11", matches: 11, current: 1 });
  });

  // Obsidian puts the moved source back as far down as it was, which shows
  // other lines where they wrap otherwise in the new pane: line 19 in place
  // of line 37 in a narrower tab group, and line 58 in a wider one, on both
  // versions, with the view as main at eb926d3 has it.
  for (const into of ["narrower", "wider"] as const) {
    it(`keeps the Source view's line in a ${into} tab group, where its lines wrap otherwise (#189)`, async function () {
      await writeParagraphsPage();
      await openInActiveTab(PARAGRAPHS);
      await clickToolbarButton("Source");
      await prepareTabGroups(into === "narrower" ? { other: 400 } : { own: 400 });
      await scrollViewSourceToLine(37);
      await browser.pause(300);
      const before = (await sourceLine())!;
      expect(before.line).toBe(37);

      await moveToOtherGroup();
      const after = await expectSourceAtLine(37);
      // The premise: line 37 is elsewhere in the source's new width.
      expect(Math.abs(after.width - before.width)).toBeGreaterThan(200);
      expect(Math.abs(after.top - before.top)).toBeGreaterThan(200);
    });
  }

  // On Obsidian 1.5.3, the new window's app.css can arrive after the view has
  // put the source back at its line, laid out without it, where the lines
  // then take other heights. Holding it back until then makes that so in
  // every run. On 1.15.1 the lines have their height without app.css. With
  // the view as main at eb926d3 has it, the source never showed line 37
  // while app.css was held back, on both versions.
  it("keeps the Source view's line in a new window once Obsidian's styles arrive there (#189)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Source");
    await scrollViewSourceToLine(37);
    await browser.pause(300);

    const held = await moveToWindowHoldingStyles(37, true);
    expect(held).toMatchObject({ held: true, released: true, followed: true });
    expect((await expectSourceAtLine(37)).inWindow).toBe(true);
  });

  // With the view as main at eb926d3 has it, the source showed line 49 in
  // the new window on Obsidian 1.5.3.
  it("keeps the Source view's line in a new window, where its lines wrap otherwise (#189)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Source");
    await scrollViewSourceToLine(37);
    await browser.pause(300);
    const before = (await sourceLine())!;

    await moveActiveTab("window");
    const after = await expectSourceAtLine(37);
    expect(after.inWindow).toBe(true);
    expect(after.width).toBeGreaterThan(before.width + 200);
  });

  // The head's 300 rules share the page's first 8 pixels. With the view as
  // main at eb926d3 has it, the placed page led, and the source went from
  // line 150 to line 155 in another tab group, and to line 194 on Obsidian
  // 1.15.1 and 174 on 1.5.3 in a new window. The new window's app.css is held
  // back until the view has put the source at its line, laid out without it:
  // the source keeps its line when the styles arrive (#165).
  for (const to of ["group", "window"] as const) {
    it(`keeps the split view's source at its line among a long head's in ${to === "group" ? "another tab group" : "a new window"}, where the source led last (#195)`, async function () {
      await openInActiveTab(await writeLongHeadPage());
      await clickToolbarButton("Split");
      await waitForPage();
      await scrollViewSourceToLine(150);
      await browser.pause(500);
      const before = (await pageState(false))!;
      expect(before.line).toBe(150);

      if (to === "window")
        expect(await moveToWindowHoldingStyles(150)).toMatchObject({
          held: true,
          released: true,
          followed: true,
        });
      else await moveActiveTab(to);
      await waitForMovedPage();
      const after = await expectSourceAtLine(150);
      expect(after.inWindow).toBe(to === "window");
      // The page follows it, as far down as it was.
      expect(Math.abs((await pageState(true))!.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
    });
  }

  // Until the moved page has loaded, Chromium's scroll anchoring can scroll it
  // as its images arrive: that leads nothing, and the page follows the source
  // again once it has loaded. A script's scroll stands in for the anchoring.
  it("keeps the split view's source at its line among a long head's while the moved page loads, whatever the page scrolls meanwhile (#195)", async function () {
    const image = await heldImage();
    try {
      await openInActiveTab(await writeLongHeadPage({ image: image.url }));
      await clickToolbarButton("Split");
      await waitForParsedPage();
      await scrollViewSourceToLine(150);
      await browser.pause(500);
      const before = (await pageState(false))!;
      expect(before.line).toBe(150);

      await moveActiveTab("group");
      await waitForMovedPage(
        (state) => state.readyState === "interactive" && state.line === 150,
        "its page before it loaded, beside the source at line 150",
      );
      await browser.executeObsidian(({ app }) => {
        app.workspace.iterateAllLeaves((leaf) => {
          leaf.view.containerEl
            .querySelector<HTMLIFrameElement>("iframe[data-e2e-moved]")
            ?.contentWindow?.scrollTo(0, 3000);
        });
      });
      await browser.pause(300);
      expect(await pageState(true)).toMatchObject({ readyState: "interactive", line: 150 });

      image.release();
      await waitForMovedPage();
      await expectSourceAtLine(150);
      expect(Math.abs((await pageState(true))!.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
    } finally {
      image.close();
    }
  });

  // The head's rules wrap onto two rows in the narrower pane, where
  // Obsidian puts the source back as far down as it was, which shows other
  // lines: the source goes back to its line there, and then leads. With the
  // view as main at eb926d3 has it, the source showed line 58 on Obsidian
  // 1.15.1 and line 20 on 1.5.3.
  it("keeps the split view's source at its line in a narrower tab group, where its lines wrap otherwise and the source led last (#195)", async function () {
    await openInActiveTab(await writeLongHeadPage({ wide: true }));
    await clickToolbarButton("Split");
    await waitForPage();
    await prepareTabGroups({ other: 300 });
    await scrollViewSourceToLine(150);
    await browser.pause(500);
    const before = (await sourceLine())!;
    expect(before.line).toBe(150);

    await moveToOtherGroup();
    await waitForMovedPage();
    const after = await expectSourceAtLine(150);
    // The premise: line 150 is elsewhere in the source's new width.
    expect(after.top).toBeGreaterThan(before.top + 300);
  });

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

/** What showTabAgain saw while the tab was hidden, and whether it shows again. */
interface ShownAgain {
  /** How far down the tab's page was while hidden, or null without a page. */
  readonly hiddenPageY: number | null;
  /** Whether the tab shows, in the page. */
  readonly shows: boolean;
}

/**
 * Hides a tab behind a new tab of its tab group, as the tab group's new-tab
 * button does, and shows it again (#178): the active tab, or with `marked`,
 * the tab that showTabAgain or the test marked before, in whichever window
 * it is.
 *
 * Before the hide, it waits for Chromium to report the scrolling that the
 * test has done, which a scroll still unreported when the tab hides would
 * lose. It shows the tab again once the hidden page's scroll to its start
 * has been reported, and a frame after it, when the split view would have
 * followed it.
 *
 * By default it shows the tab as the reader's click on its tab header does:
 * it clicks the header in a task of its own, which runs Obsidian's handler
 * of that click. Chromium then lays the view out in that task, and a split
 * view's source whose lines wrap reports where Chromium laid it out at the
 * start of the next frame, before the frame's ResizeObserver reports. With
 * `inFrame`, it shows the tab through Obsidian's API inside an animation
 * frame's callback, after that frame's scroll events: the frame's observer
 * reports later in that frame, before the source. The frame and the source
 * are marked as moveActiveTab marks them, for pageState(true) and
 * movedSource to find.
 *
 * Given `width`, the tab's view has that width, in CSS pixels, while the tab
 * is hidden and when it shows again, as where a sidebar opened meanwhile.
 * Given `scrolledTo`, the id of an element of the page, the page is first
 * scrolled to that element's top, and the tab hides two frames later, once
 * Chromium has reported that scroll and before it has settled; given
 * `sourceScrolledTo`, a line's number, the source is scrolled to that line's
 * top so. With
 * `readableLineLengthOff`, Obsidian's Readable line length is first turned
 * off, and the tab hides two frames after the page's text took the pane's
 * width, once the page's window has reported that change of its layout.
 */
async function showTabAgain({
  inFrame = false,
  marked = false,
  width,
  scrolledTo,
  sourceScrolledTo,
  readableLineLengthOff = false,
}: {
  inFrame?: boolean;
  marked?: boolean;
  width?: number;
  scrolledTo?: string;
  sourceScrolledTo?: number;
  readableLineLengthOff?: boolean;
} = {}): Promise<ShownAgain> {
  const shown = await browser.executeObsidian(
    async (
      { app },
      inFrame,
      marked,
      width,
      scrolledTo,
      sourceScrolledTo,
      readableLineLengthOff,
    ) => {
      const kept = window as unknown as {
        e2eShownAgain: NonNullable<ReturnType<typeof app.workspace.getMostRecentLeaf>>;
      };
      const leaf = marked ? kept.e2eShownAgain : app.workspace.getMostRecentLeaf()!;
      const container = leaf.view.containerEl;
      const view = container.ownerDocument.defaultView!;
      const frame = (): Promise<void> =>
        new Promise((resolve) => view.requestAnimationFrame(() => resolve()));
      const task = (): Promise<void> => new Promise((resolve) => view.setTimeout(resolve, 0));
      // A new tab opens in the tab group of the active tab.
      if (marked) app.workspace.setActiveLeaf(leaf, { focus: true });
      const iframe = container.querySelector<HTMLIFrameElement>("iframe");
      const page = iframe?.contentWindow;
      const element = scrolledTo ? iframe?.contentDocument?.getElementById(scrolledTo) : null;
      if (page && element) page.scrollTo(0, page.scrollY + element.getBoundingClientRect().top);
      const scrolledSource = container.querySelector<HTMLElement>(".html-page-viewer__source");
      const line =
        sourceScrolledTo === null
          ? undefined
          : scrolledSource?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[
              sourceScrolledTo - 1
            ];
      if (scrolledSource && line) scrolledSource.scrollTop = line.offsetTop;
      if (readableLineLengthOff && page) {
        const width = page.document.body.getBoundingClientRect().width;
        (app.vault as unknown as { setConfig(setting: string, value: unknown): void }).setConfig(
          "readableLineLength",
          false,
        );
        for (
          let count = 0;
          page.document.body.getBoundingClientRect().width === width && count < 120;
          count += 1
        )
          await frame();
      }
      await frame();
      await frame();
      const source = container.querySelector<HTMLElement>(".html-page-viewer__source");
      iframe?.setAttribute("data-e2e-moved", "");
      source?.setAttribute("data-e2e-moved", "");
      kept.e2eShownAgain = leaf;
      const win = iframe?.contentWindow ?? null;
      let reported = !win || win.scrollY === 0;
      win?.addEventListener("scroll", () => (reported = true), { once: true });
      app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true });
      for (let count = 0; !reported && count < 120; count += 1) await frame();
      await frame();
      const hiddenPageY = win?.scrollY ?? null;
      if (width !== undefined)
        container
          .querySelector<HTMLElement>(".view-content")
          ?.style.setProperty("width", `${width}px`);
      if (inFrame) {
        app.workspace.setActiveLeaf(leaf, { focus: true });
      } else {
        await task();
        (leaf as unknown as { tabHeaderEl: HTMLElement }).tabHeaderEl.click();
      }
      await frame();
      await frame();
      return {
        hiddenPageY,
        shows: container.isConnected && view.getComputedStyle(container).display !== "none",
      };
    },
    inFrame,
    marked,
    width,
    scrolledTo,
    sourceScrolledTo ?? null,
    readableLineLengthOff,
  );
  expect(shown.shows).toBe(true);
  return shown;
}

/**
 * Hides the active tab behind a new tab of its tab group, marks it, its frame,
 * and its source as moveActiveTab marks them, and waits until the frame, or
 * in the **Source** view the source, has no height. Returns nothing; the tab
 * is `e2eShownAgain` in the main window.
 */
async function hideActiveTab(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const leaf = app.workspace.getMostRecentLeaf()!;
    const container = leaf.view.containerEl;
    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await frame();
    await frame();
    const iframe = container.querySelector<HTMLIFrameElement>("iframe");
    const source = container.querySelector<HTMLElement>(".html-page-viewer__source");
    if (iframe) {
      iframe.dataset.e2eMoved = "";
      iframe.contentDocument!.documentElement.dataset.e2eBefore = "";
    }
    source?.setAttribute("data-e2e-moved", "");
    (window as unknown as { e2eShownAgain: typeof leaf }).e2eShownAgain = leaf;
    app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true });
    const shown = (iframe ?? source)!;
    for (let count = 0; shown.clientHeight !== 0 && count < 120; count += 1) await frame();
    await frame();
    await frame();
  });
}

/**
 * Runs Obsidian's **Split down** command, `workspace:split-horizontal`, on the
 * tab in front of the hidden tab that hideActiveTab hid. Obsidian lays the tab
 * group out anew, so the hidden tab's frame drops its document and loads its
 * copy again, while the tab stays hidden and the frame has no size (#186).
 * With `closeAgain`, it then closes the new pane below, with the tab in front
 * still active, and Obsidian lays the tab group out anew once more. It waits
 * for each of the frame's next documents to load, and returns how many the
 * frame loaded, and the frame's height.
 */
async function splitDownWhileHidden(
  closeAgain: boolean,
): Promise<{ readonly reloads: number; readonly height: number }> {
  return browser.executeObsidian(async ({ app }, closeAgain) => {
    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const leaf = (window as unknown as { e2eShownAgain: { view: { containerEl: HTMLElement } } })
      .e2eShownAgain;
    const iframe = leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe")!;
    const seen = new Set<Document | null>([iframe.contentDocument]);
    let reloads = 0;
    /** Waits for a document that the frame did not have before to load. */
    const reloaded = async (): Promise<void> => {
      for (let count = 0; count < 240; count += 1) {
        const doc = iframe.contentDocument;
        if (doc && !seen.has(doc) && doc.URL === "about:srcdoc" && doc.readyState === "complete") {
          seen.add(doc);
          reloads += 1;
          break;
        }
        await frame();
      }
      await frame();
      await frame();
    };
    const front = app.workspace.getMostRecentLeaf()!;
    const commands = (app as unknown as { commands: { executeCommandById(id: string): boolean } })
      .commands;
    if (!commands.executeCommandById("workspace:split-horizontal"))
      throw new Error("Split down did not run");
    await reloaded();
    if (closeAgain) {
      // The pane below is every tab of the main area outside the hidden
      // tab's tab group.
      const group = (leaf as unknown as { parent: unknown }).parent;
      const below: (typeof front)[] = [];
      app.workspace.iterateRootLeaves((each) => {
        if ((each as unknown as { parent: unknown }).parent !== group) below.push(each);
      });
      if (below.length === 0) throw new Error("Split down made no pane below");
      for (const each of below) each.detach();
      app.workspace.setActiveLeaf(front, { focus: true });
      await reloaded();
    }
    return { reloads, height: iframe.clientHeight };
  }, closeAgain);
}

/**
 * Shows the hidden tab that hideActiveTab hid, as the reader's click on its
 * tab header does: the header's `click()` in a task of its own, as
 * showTabAgain shows a tab.
 */
async function showHiddenTab(): Promise<void> {
  const shows = await browser.executeObsidian(async () => {
    const leaf = (
      window as unknown as {
        e2eShownAgain: { tabHeaderEl: HTMLElement; view: { containerEl: HTMLElement } };
      }
    ).e2eShownAgain;
    const container = leaf.view.containerEl;
    const view = container.ownerDocument.defaultView!;
    const frame = (): Promise<void> =>
      new Promise((resolve) => view.requestAnimationFrame(() => resolve()));
    await new Promise((resolve) => view.setTimeout(resolve, 0));
    leaf.tabHeaderEl.click();
    await frame();
    await frame();
    return container.isConnected && view.getComputedStyle(container).display !== "none";
  });
  expect(shows).toBe(true);
}

/**
 * Moves the hidden tab that hideActiveTab hid to a new tab group beside it,
 * with the calls that Obsidian makes when a tab is dropped on another tab
 * group, as moveActiveTab does for the active tab. It shows there.
 */
async function moveHiddenTabToGroup(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    // Not in Obsidian's API types; 1.5.3 and 1.15.1 have them.
    interface Parent {
      children: unknown[];
      removeChild(child: unknown): void;
      insertChild(index: number, child: unknown): void;
      selectTabIndex(index: number): void;
    }
    const leaf = (window as unknown as { e2eShownAgain: unknown }).e2eShownAgain as {
      parent: Parent;
      setDimension(size: null): void;
    };
    const split = app.workspace.getLeaf("split", "vertical") as unknown as { parent: Parent };
    leaf.parent.removeChild(leaf);
    leaf.setDimension(null);
    split.parent.insertChild(-1, leaf);
    split.parent.selectTabIndex(split.parent.children.indexOf(leaf));
    app.workspace.setActiveLeaf(leaf as never, { focus: true });
  });
}

/**
 * Hides the active tab behind a new tab of its tab group, and moves it to a
 * new window with its tab header's menu, **Move to new window**, as a reader
 * moves a tab that they are not looking at (#186). It opens the menu with
 * the header's `contextmenu` event and clicks the item with its `click()`,
 * not with WebDriver's pointer, as showTabAgain clicks the header. The tab
 * shows in the new window. The frame and the source are marked as
 * moveActiveTab marks them.
 */
async function moveHiddenTabByMenu(): Promise<void> {
  await hideActiveTab();
  const item = await browser.executeObsidian(async () => {
    const leaf = (window as unknown as { e2eShownAgain: { tabHeaderEl: HTMLElement } })
      .e2eShownAgain;
    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const task = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const header = leaf.tabHeaderEl;
    const box = header.getBoundingClientRect();
    header.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
    let found: HTMLElement | undefined;
    for (let count = 0; !found && count < 60; count += 1) {
      await frame();
      found = [...document.querySelectorAll<HTMLElement>(".menu .menu-item")].find(
        (candidate) => candidate.textContent?.trim() === "Move to new window",
      );
    }
    await task();
    found?.click();
    return found?.textContent?.trim() ?? null;
  });
  expect(item).toBe("Move to new window");
}

/**
 * Checks that the page that showTabAgain showed again is at `place`, and
 * stays there: a moment later, after Obsidian's resize of the view and
 * anything else that the showing starts.
 */
async function expectShownAgainAt(place: { scrollY: number; top: number }): Promise<void> {
  for (const wait of [0, 500]) {
    await browser.pause(wait);
    const after = (await pageState(true))!;
    expect({ scrollY: after.scrollY, top: after.top }).toEqual({
      scrollY: place.scrollY,
      top: place.top,
    });
  }
}

/**
 * Opens the long page in the active tab's split view, as openLongPageSplit
 * does, and scrolls its source on to line 30, which the page follows to
 * paragraph 22.
 */
async function openLongPageSplitAtLine30(): Promise<void> {
  await openLongPageSplit();
  await scrollSourceToLine(30);
  await browser.waitUntil(async () => Math.abs(((await pageState(false))?.top ?? 0) - 22) <= 1, {
    timeout: 5000,
    timeoutMsg: "the page did not follow the source to paragraph 22",
  });
}

/** The page and the source of the tab that showTabAgain marked, or of the active tab. */
async function splitSides(marked: boolean): Promise<{ page: PageState; source: number }> {
  const page = (await pageState(marked))!;
  const source = marked
    ? (await movedSource())!.top
    : await browser.execute(
        (active) =>
          document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!.scrollTop,
        ACTIVE,
      );
  return { page, source };
}

/**
 * Checks that the split view that showTabAgain showed again has its page
 * and its source where they were, `before`, and that they stay there. A
 * pixel of either side is allowed, as the side that led last puts the
 * other in step from where it is.
 */
async function expectSplitShownAgainAt(before: { page: PageState; source: number }): Promise<void> {
  for (const wait of [0, 500]) {
    await browser.pause(wait);
    const after = await splitSides(true);
    expect(Math.abs(after.page.scrollY - before.page.scrollY)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.source - before.source)).toBeLessThanOrEqual(1);
    expect({ top: after.page.top, line: after.page.line }).toEqual({
      top: before.page.top,
      line: before.page.line,
    });
  }
}

/**
 * Writes a page whose head has 300 one-line rules, before 60 long paragraphs.
 * With `wide`, each rule is about 50 characters long, which fits on one row
 * of the split view's source beside the page in a pane 900 pixels wide, and
 * wraps onto two above it in a pane 300 pixels wide. With `image`, an image
 * of that URL follows the paragraphs.
 */
async function writeLongHeadPage({
  wide = false,
  image,
}: { wide?: boolean; image?: string } = {}): Promise<string> {
  const rules = Array.from(
    { length: 300 },
    (_, index) => `.rule-${index + 1} { color: #123456;${wide ? " background: #abcdef;" : ""} }`,
  ).join("\n");
  const name = image ? "Long held head" : wide ? "Long wide head" : "Long head";
  const after = image
    ? `<img src="${image}" alt="An image that arrives only when the test says" width="16" height="16">\n`
    : "";
  const path = `Saved/${name}.html`;
  await writePage(
    path,
    "Long head",
    `<style>\n${rules}\n</style>\n`,
    `${paragraphs(1, 60)}\n${after}`,
  );
  return path;
}

/**
 * Scrolls the active tab's source, in the **Source** view or the split view,
 * to show line `number` at its top, and marks it for sourceLine.
 */
async function scrollViewSourceToLine(number: number): Promise<void> {
  await browser.execute(
    (active, number) => {
      const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`);
      const line = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[
        number - 1
      ];
      if (!source || !line) throw new Error(`No line ${number}`);
      source.dataset.e2eMoved = "";
      source.scrollTop = line.offsetTop;
    },
    ACTIVE,
    number,
  );
}

/** The source that a test marked with `data-e2e-moved`, in whichever window it is. */
interface MarkedSource {
  /** How far it is scrolled down, in CSS pixels, and the number of the first line at its top. */
  readonly top: number;
  readonly line: number;
  /** How wide it is, in CSS pixels. */
  readonly width: number;
  readonly inWindow: boolean;
}

async function sourceLine(): Promise<MarkedSource | null> {
  return browser.executeObsidian(({ app }) => {
    const found: MarkedSource[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const source = leaf.view.containerEl.querySelector<HTMLElement>(
        ".html-page-viewer__source[data-e2e-moved]",
      );
      if (!source) return;
      const lines = [...source.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")];
      found.push({
        top: source.scrollTop,
        line:
          lines.findIndex((each) => each.offsetTop + each.offsetHeight > source.scrollTop + 1) + 1,
        width: source.clientWidth,
        inWindow: source.ownerDocument !== document,
      });
    });
    return found[0] ?? null;
  });
}

/**
 * Checks that the marked source shows line `number` at its top, and still
 * does a moment later, after Obsidian's resize of the view and anything else
 * that the move or the showing starts.
 */
async function expectSourceAtLine(number: number): Promise<MarkedSource> {
  let after: MarkedSource | null = null;
  try {
    await browser.waitUntil(
      async () => {
        after = await sourceLine();
        return after?.line === number;
      },
      { timeout: 5000 },
    );
  } catch {
    throw new Error(`The source did not show line ${number}: ${JSON.stringify(after)}`);
  }
  await browser.pause(500);
  const later = (await sourceLine())!;
  expect(later.line).toBe(number);
  return later;
}

/**
 * Makes a second tab group beside the active tab's, and a second tab in the
 * active tab's tab group, so that it stays when the active tab moves to the
 * other; the active tab shows again. The active tab's tab group is at most
 * `own` pixels wide, and the other at most `other`, as Obsidian's panes take
 * the width that the other leaves. Run it before the test scrolls the view:
 * the active tab is hidden for a moment.
 */
async function prepareTabGroups({ own, other }: { own?: number; other?: number }): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, own, other) => {
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      interface Tabs {
        containerEl: HTMLElement;
      }
      const leaf = app.workspace.getMostRecentLeaf()!;
      const ownTabs = (leaf as unknown as { parent: Tabs }).parent;
      const split = app.workspace.getLeaf("split", "vertical") as unknown as { parent: Tabs };
      if (own !== null) ownTabs.containerEl.style.setProperty("max-width", `${own}px`);
      if (other !== null) split.parent.containerEl.style.setProperty("max-width", `${other}px`);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      app.workspace.getLeaf("tab");
      app.workspace.setActiveLeaf(leaf, { focus: true });
      (window as unknown as { e2eOtherGroup: unknown }).e2eOtherGroup = split.parent;
      for (let count = 0; count < 6; count += 1) await frame();
    },
    own ?? null,
    other ?? null,
  );
}

/**
 * Moves the active tab into the tab group that prepareTabGroups made, with the
 * calls that Obsidian makes when a tab is dropped on another tab group, as
 * moveActiveTab does. The frame is marked as moveActiveTab marks it.
 */
async function moveToOtherGroup(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    interface Tabs {
      children: unknown[];
      removeChild(child: unknown): void;
      insertChild(index: number, child: unknown): void;
      selectTabIndex(index: number): void;
    }
    const leaf = app.workspace.getMostRecentLeaf()!;
    const frame = leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe");
    if (frame) {
      frame.dataset.e2eMoved = "";
      frame.contentDocument!.documentElement.dataset.e2eBefore = "";
    }
    const moved = leaf as unknown as { parent: Tabs; setDimension(size: null): void };
    const other = (window as unknown as { e2eOtherGroup: Tabs }).e2eOtherGroup;
    moved.parent.removeChild(leaf);
    moved.setDimension(null);
    other.insertChild(-1, leaf);
    other.selectTabIndex(other.children.indexOf(leaf));
    app.workspace.setActiveLeaf(leaf, { focus: true });
  });
}

describe("A tab shown again after Obsidian hid it", function () {
  beforeEach(freshTab);

  it("shows its page where it was, after another tab of its tab group (#178)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    const before = (await pageState(false))!;
    expect(before).toMatchObject({ top: 30 });

    const shown = await showTabAgain();
    // The premise: Chromium scrolled the hidden page to its start.
    expect(shown.hiddenPageY).toBe(0);
    await expectShownAgainAt(before);
  });

  it("leaves its page at its top where the reader scrolled it there (#178)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    const frame = await browser.execute((active) => {
      const box = document
        .querySelector(`${active} iframe.html-page-viewer__frame`)!
        .getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    }, ACTIVE);
    await browser
      .action("wheel")
      .scroll({ ...frame, deltaX: 0, deltaY: -20_000, duration: 100 })
      .perform();
    await browser.waitUntil(async () => (await pageState(false))?.scrollY === 0, {
      timeout: 5000,
      timeoutMsg: "the reader's wheel did not scroll the page to its top",
    });

    await showTabAgain();
    await expectShownAgainAt({ scrollY: 0, top: 1 });
  });

  it("shows its page where the find bar scrolled it (#178)", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await browser.$(`${ACTIVE} button[aria-label="Find in page"]`).click();
    await browser.$(`${ACTIVE} .html-page-viewer__find input`).setValue("Paragraph 45 of");
    await browser.keys("Enter");
    await browser.waitUntil(async () => ((await pageState(false))?.top ?? 0) > 30, {
      timeout: 5000,
      timeoutMsg: "the find bar did not scroll the page to paragraph 45",
    });
    const before = (await pageState(false))!;

    await showTabAgain();
    await expectShownAgainAt(before);
    const count = await browser.execute(
      (active) => document.querySelector(`${active} .html-page-viewer__find-count`)?.textContent,
      ACTIVE,
    );
    expect(count).toBe("1 of 1");
  });

  // Chromium reports the find bar's scroll only in its next frame, after the
  // hide: the view keeps where the find bar put the page itself.
  it("shows its page where the find bar scrolled it in the task that hid the tab (#178)", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await browser.$(`${ACTIVE} button[aria-label="Find in page"]`).click();
    await browser.execute((active) => {
      document
        .querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`)!
        .contentWindow!.scrollTo(0, 600);
    }, ACTIVE);
    await nextFrames();
    const result = await browser.executeObsidian(async ({ app }) => {
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const leaf = app.workspace.getMostRecentLeaf()!;
      const container = leaf.view.containerEl;
      const win = container.querySelector("iframe")!.contentWindow!;
      const input = container.querySelector<HTMLInputElement>(".html-page-viewer__find input")!;
      input.value = "Paragraph 45 of";
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      const found = win.scrollY;
      app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true });
      for (let count = 0; count < 4; count += 1) await frame();
      const hidden = win.scrollY;
      app.workspace.setActiveLeaf(leaf, { focus: true });
      for (let count = 0; count < 4; count += 1) await frame();
      return { found, hidden, after: win.scrollY };
    });
    expect(result.found).toBeGreaterThan(1000);
    expect(result.hidden).toBe(0);
    expect(result.after).toBe(result.found);
  });

  it("keeps the split view's sides where they were, in step (#178)", async function () {
    await openLongPageSplitAtLine30();
    const before = await splitSides(false);

    await showTabAgain();
    await expectSplitShownAgainAt(before);
  });

  // Where the source's lines wrap, as they do by default, Chromium lays the
  // source out other than it was when the tab shows again: 187 px further
  // down on Obsidian 1.15.1, and 56 px on 1.5.3, here. The view puts it back.
  for (const inFrame of [false, true]) {
    it(`keeps the split view's sides through three switches, where the source's lines wrap and the page led, ${inFrame ? "with the frame's observer first" : "shown by a click on its tab header"} (#178)`, async function () {
      await writeParagraphsPage();
      await openInActiveTab(PARAGRAPHS);
      await clickToolbarButton("Split");
      await waitForPage();
      await scrollToParagraph(30, 0.5);
      await browser.waitUntil(async () => ((await pageState(false))?.line ?? 0) > 30, {
        timeout: 5000,
        timeoutMsg: "the source did not follow the page to paragraph 30",
      });
      await browser.pause(300);
      const before = await splitSides(false);
      expect(before.page.top).toBe(30);

      for (let round = 0; round < 3; round += 1) {
        await showTabAgain({ inFrame });
        await expectSplitShownAgainAt(before);
      }
    });
  }

  it("keeps the split view's sides through three switches, where the source's lines wrap and the source led (#178)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Split");
    await waitForPage();
    await scrollSourceToLine(40);
    await browser.waitUntil(async () => ((await pageState(false))?.top ?? 0) > 20, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the source to line 40",
    });
    await browser.pause(300);
    const before = await splitSides(false);

    for (let round = 0; round < 3; round += 1) {
      await showTabAgain();
      await expectSplitShownAgainAt(before);
    }
  });

  // Many of the source's lines, those of the head, share the page's first
  // pixels: were the page to lead, the source would go to another line.
  it("leaves the split view's source where the reader scrolled it, among the lines of a long head (#178)", async function () {
    await openInActiveTab(await writeLongHeadPage());
    await clickToolbarButton("Split");
    await waitForPage();
    await scrollSourceToLine(150);
    await browser.pause(500);
    const before = await splitSides(false);
    expect(before.page.line).toBe(150);

    await showTabAgain();
    await expectSplitShownAgainAt(before);
  });

  // The view puts the sides back in the frame of the frame's ResizeObserver;
  // an observer made after the view's reports after it, in the same frame,
  // and the reader's scroll there leads.
  it("follows the reader's scroll of the split view's source in the frame in which the sides go back (#178)", async function () {
    await openLongPageSplitAtLine30();
    await browser.pause(500);
    const at = await browser.executeObsidian(async ({ app }) => {
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const leaf = app.workspace.getMostRecentLeaf()!;
      const container = leaf.view.containerEl;
      const iframe = container.querySelector("iframe")!;
      const source = container.querySelector<HTMLElement>(".html-page-viewer__source")!;
      iframe.setAttribute("data-e2e-moved", "");
      source.setAttribute("data-e2e-moved", "");
      app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true });
      for (let count = 0; count < 4; count += 1) await frame();
      let seen: { page: number; source: number } | null = null;
      const observer = new ResizeObserver(() => {
        if (iframe.clientHeight === 0 || seen !== null) return;
        seen = { page: iframe.contentWindow!.scrollY, source: source.scrollTop };
        const line = source.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[9];
        source.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -200 }));
        source.scrollTop = line.offsetTop;
      });
      observer.observe(iframe);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      for (let count = 0; count < 6; count += 1) await frame();
      observer.disconnect();
      return seen as { page: number; source: number } | null;
    });
    // When the reader scrolled, the page was back at paragraph 22.
    expect(at).not.toBeNull();
    expect(at!.page).toBe(920);
    await browser.waitUntil(async () => ((await pageState(true))?.top ?? 99) <= 3, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the reader's scroll of the source to line 10",
    });
    await browser.pause(500);
    const after = (await pageState(true))!;
    expect(after.line).toBe(10);
    expect(Math.abs(after.top - 2)).toBeLessThanOrEqual(1);
  });

  // As a quick switch to another tab and back does: the tab shows again in
  // the frame after the hidden page reported its scroll to its start, which
  // the view does not follow, and the sides go back in step.
  it("keeps the split view's sides in step when its tab shows again at once (#178)", async function () {
    await openLongPageSplitAtLine30();
    await browser.pause(500);
    const before = await splitSides(false);

    const shown = await showTabAgain({ inFrame: true });
    expect(shown.hiddenPageY).toBe(0);
    await expectSplitShownAgainAt(before);
  });

  it("keeps the split view's sides where the reader scrolled them between two switches (#178)", async function () {
    await openLongPageSplitAtLine30();
    await showTabAgain();
    await scrollSourceToLine(10);
    await browser.waitUntil(async () => ((await pageState(true))?.top ?? 99) <= 3, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the source to line 10",
    });
    await browser.pause(300);
    const before = await splitSides(true);
    expect(before.page.line).toBe(10);

    await showTabAgain();
    await expectSplitShownAgainAt(before);
  });

  // Obsidian's tab header menu moves a tab to a new window with
  // moveLeafToPopout, also a hidden tab, which then shows there. The frame
  // drops the page that it showed while the tab is hidden, and no showing of
  // that page follows.
  it("keeps the split view's sides where the reader scrolled them after its hidden tab moved to a new window (#178)", async function () {
    await openLongPageSplitAtLine30();
    await browser.pause(300);
    await browser.executeObsidian(async ({ app }) => {
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await frame();
      await frame();
      const leaf = app.workspace.getMostRecentLeaf()!;
      const container = leaf.view.containerEl;
      const iframe = container.querySelector<HTMLIFrameElement>("iframe")!;
      iframe.dataset.e2eMoved = "";
      iframe.contentDocument!.documentElement.dataset.e2eBefore = "";
      container.querySelector(".html-page-viewer__source")!.setAttribute("data-e2e-moved", "");
      (window as unknown as { e2eShownAgain: typeof leaf }).e2eShownAgain = leaf;
      app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true });
      for (let count = 0; iframe.clientHeight !== 0 && count < 120; count += 1) await frame();
      await frame();
      await frame();
      app.workspace.moveLeafToPopout(leaf);
    });
    expect(await waitForMovedPage()).toMatchObject({ inWindow: true });
    await browser.pause(500);
    // The reader's wheel in the source in the new window, to line 10.
    await browser.executeObsidian(() => {
      const leaf = (window as unknown as { e2eShownAgain: { view: { containerEl: HTMLElement } } })
        .e2eShownAgain;
      const source = leaf.view.containerEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
      const win = source.ownerDocument.defaultView!;
      source.dispatchEvent(new win.WheelEvent("wheel", { bubbles: true, deltaY: -200 }));
      source.scrollTop = source.querySelectorAll<HTMLElement>(
        ".html-page-viewer__source-line",
      )[9].offsetTop;
    });
    await browser.waitUntil(async () => ((await pageState(true))?.top ?? 99) <= 3, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the source to line 10",
    });
    await browser.pause(500);
    const before = await splitSides(true);
    expect(before.page.line).toBe(10);

    await showTabAgain({ marked: true });
    await expectSplitShownAgainAt(before);
  });

  // Chromium keeps the places of elements that scroll by themselves, in the
  // view and in the page, when it lays them out again.
  it("keeps the Source view where it was (#178)", async function () {
    await openInActiveTab("Saved/Long page.html");
    await clickToolbarButton("Source");
    const before = await browser.execute((active) => {
      const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__source`)!;
      source.scrollTop = 571;
      return source.scrollTop;
    }, ACTIVE);
    expect(before).toBe(571);

    await showTabAgain();
    await browser.pause(500);
    expect((await movedSource())?.top).toBe(before);
  });

  it("keeps the place of a page that scrolls inside an element (#178)", async function () {
    await writePage(
      "Saved/Scrolling column.html",
      "Scrolling column",
      "<style>html, body { height: 100%; margin: 0; overflow: hidden } #column { height: 100%; overflow: auto }</style>\n",
      `<div id="column">\n${paragraphs(1, 60)}\n</div>\n`,
    );
    await openInActiveTab("Saved/Scrolling column.html");
    await waitForPage();
    const before = await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      )!.contentDocument!;
      const column = doc.getElementById("column")!;
      column.scrollTop = doc.getElementById("p30")!.offsetTop;
      return column.scrollTop;
    }, ACTIVE);
    expect(before).toBeGreaterThan(1000);

    await showTabAgain();
    await browser.pause(500);
    const after = await browser.executeObsidian(() => {
      const leaf = (window as unknown as { e2eShownAgain: { view: { containerEl: HTMLElement } } })
        .e2eShownAgain;
      return (
        leaf.view.containerEl.querySelector("iframe")?.contentDocument?.getElementById("column")
          ?.scrollTop ?? null
      );
    });
    expect(after).toBe(before);
  });

  // Obsidian hides a collapsed sidebar with display: none too.
  it("shows its page where it was when its sidebar is expanded again (#178)", async function () {
    await writeParagraphsPage();
    await browser.executeObsidian(async ({ app }, path) => {
      const leaf = app.workspace.getRightLeaf(true)!;
      await leaf.openFile(app.vault.getAbstractFileByPath(path) as never);
      app.workspace.rightSplit.expand();
      app.workspace.revealLeaf(leaf);
      leaf.view.containerEl.querySelector("iframe")?.setAttribute("data-e2e-moved", "");
      (window as unknown as { e2eSidebarLeaf: typeof leaf }).e2eSidebarLeaf = leaf;
    }, PARAGRAPHS);
    try {
      await browser.waitUntil(async () => (await pageState(true))?.readyState === "complete", {
        timeout: 20_000,
        timeoutMsg: "the sidebar's page did not load",
      });
      const result = await browser.executeObsidian(async ({ app }) => {
        const frame = (): Promise<void> =>
          new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const leaf = (
          window as unknown as { e2eSidebarLeaf: { view: { containerEl: HTMLElement } } }
        ).e2eSidebarLeaf;
        const iframe = leaf.view.containerEl.querySelector("iframe")!;
        const win = iframe.contentWindow!;
        // The sidebar can take a moment to collapse and to expand.
        const until = async (done: () => boolean): Promise<void> => {
          for (let count = 0; !done() && count < 120; count += 1) await frame();
          await frame();
          await frame();
        };
        win.scrollTo(0, 2000);
        await frame();
        await frame();
        const before = win.scrollY;
        app.workspace.rightSplit.collapse();
        await until(() => iframe.clientHeight === 0);
        const collapsed = win.scrollY;
        app.workspace.rightSplit.expand();
        await until(() => iframe.clientHeight !== 0);
        return { before, collapsed, after: win.scrollY };
      });
      expect(result).toEqual({ before: 2000, collapsed: 0, after: 2000 });
    } finally {
      await browser.executeObsidian(({ app }) => {
        (window as unknown as { e2eSidebarLeaf?: { detach(): void } }).e2eSidebarLeaf?.detach();
        app.workspace.rightSplit.collapse();
      });
    }
  });

  // The page wraps onto more lines in the narrower view, so that the height
  // that it was scrolled to shows another part there: paragraph 14 in place
  // of paragraph 30 on Obsidian 1.15.1, and paragraph 15 on 1.5.3, with the
  // view as main at c3411ee has it.
  it("shows the part of its page that it showed, where its view narrowed while the tab was hidden (#182)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    // Without the theme's line width, the page takes the pane's width.
    await clickToolbarButton("Theme ON");
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    // The view measures the element at the page's top once its scrolling
    // has settled.
    await browser.pause(300);
    const before = (await pageState(false))!;
    expect(before.top).toBe(30);

    await showTabAgain({ width: 500 });
    for (const wait of [0, 500]) {
      await browser.pause(wait);
      const after = (await pageState(true))!;
      expect(after.text).toBeLessThan(before.text - 300);
      expect(after.top).toBe(30);
    }
  });

  // With the view as main at c3411ee has it, the sides came back in step at
  // paragraph 21 and line 28, in place of paragraph 30 and line 37, on both
  // versions, where the page led. Where the source led, it leads again once
  // the sides are back, so it needs its line as much as the page needs its
  // paragraph.
  for (const led of ["page", "source"] as const) {
    it(`keeps the split view's sides at the paragraph and the line that they showed, where its view narrowed while the tab was hidden and the ${led} led (#182)`, async function () {
      await writeParagraphsPage();
      await openInActiveTab(PARAGRAPHS);
      await clickToolbarButton("Split");
      await waitForPage();
      // Paragraph N is on line 7 + N.
      if (led === "page") await scrollToParagraph(30, 0.5);
      else await scrollSourceToLine(37);
      await browser.waitUntil(
        async () => {
          const state = await pageState(false);
          return state?.top === 30 && state.line === 37;
        },
        { timeout: 5000, timeoutMsg: "the sides did not come to paragraph 30 and line 37" },
      );
      await browser.pause(300);
      const before = await splitSides(false);

      // Wide enough that the sides stay side by side, each narrower.
      await showTabAgain({ width: 900 });
      for (const wait of [0, 500]) {
        await browser.pause(wait);
        const after = await splitSides(true);
        expect(after.page.text).toBeLessThan(before.page.text - 100);
        expect({ top: after.page.top, line: after.page.line }).toEqual({ top: 30, line: 37 });
      }
    });
  }

  // With the view as main at c3411ee has it, the moved page showed from its
  // top, on both versions.
  it("shows its page where it was after its hidden tab moved to a new window by its tab header's menu (#186)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.pause(300);
    expect((await pageState(false))?.top).toBe(30);

    await moveHiddenTabByMenu();
    const after = await waitForMovedPage();
    expect(after.inWindow).toBe(true);
    expect(after.top).toBe(30);
  });

  // With the view as main at c3411ee has it, the moved page showed from its
  // top, beside the source as far down as it was, which showed line 46 in
  // the new window.
  it("keeps the split view's sides in place and in step after its hidden tab moved to a new window by its tab header's menu (#186)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Split");
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.waitUntil(async () => ((await pageState(false))?.line ?? 0) > 30, {
      timeout: 5000,
      timeoutMsg: "the source did not follow the page to paragraph 30",
    });
    await browser.pause(300);
    const before = (await pageState(false))!;

    await moveHiddenTabByMenu();
    const after = await waitForMovedPage(
      (state) => state.readyState === "complete" && state.top === 30 && state.line === before.line,
      `its page at paragraph 30 and its source at line ${before.line}`,
    );
    expect(after.inWindow).toBe(true);
    await browser.pause(500);
    expect(await pageState(true)).toMatchObject({ top: 30, line: before.line });
  });

  // Chromium lays the source out again as far down as it was, which showed
  // line 19 in place of line 37 on both versions, with the view as main at
  // eb926d3 has it.
  it("keeps the Source view's line, where its view narrowed while the tab was hidden (#189)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Source");
    await scrollViewSourceToLine(37);
    await browser.pause(300);
    const before = (await sourceLine())!;
    expect(before.line).toBe(37);

    await showTabAgain({ width: 500 });
    const after = await expectSourceAtLine(37);
    expect(after.width).toBeLessThan(before.width - 300);
  });

  // A source's line is measured at each scroll that it reports: the tab hides
  // two frames after the scroll, within the 100 ms in which #190 lets a
  // page's scrolling settle before it measures what the page shows.
  it("keeps the Source view's line, where its tab hid two frames after a scroll and its view narrowed while hidden (#189)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Source");
    await scrollViewSourceToLine(10);
    await browser.pause(300);
    const before = (await sourceLine())!;

    await showTabAgain({ width: 500, sourceScrolledTo: 37 });
    const after = await expectSourceAtLine(37);
    expect(after.width).toBeLessThan(before.width - 300);
  });

  // With the view as main at eb926d3 has it, the source showed line 24 in
  // the new window on Obsidian 1.15.1, and line 49 on 1.5.3.
  it("keeps the Source view's line after its hidden tab moved to a new window by its tab header's menu (#189)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Source");
    await scrollViewSourceToLine(37);
    await browser.pause(300);

    await moveHiddenTabByMenu();
    expect((await expectSourceAtLine(37)).inWindow).toBe(true);
  });

  // With the view as main at eb926d3 has it, the placed page led, and the
  // source showed line 194 on Obsidian 1.15.1 and 174 on 1.5.3.
  it("keeps the split view's source at its line among a long head's after its hidden tab moved to a new window by its tab header's menu, where the source led last (#195)", async function () {
    await openInActiveTab(await writeLongHeadPage());
    await clickToolbarButton("Split");
    await waitForPage();
    await scrollViewSourceToLine(150);
    await browser.pause(500);
    const before = (await pageState(false))!;
    expect(before.line).toBe(150);

    await moveHiddenTabByMenu();
    await waitForMovedPage();
    expect((await expectSourceAtLine(150)).inWindow).toBe(true);
    expect(Math.abs((await pageState(true))!.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
  });

  for (const mode of ["rendered", "split"] as const) {
    it(`keeps the ${mode} view's place after its hidden tab moved to another tab group (#186)`, async function () {
      await writeParagraphsPage();
      await openInActiveTab(PARAGRAPHS);
      if (mode === "split") await clickToolbarButton("Split");
      await waitForPage();
      await scrollToParagraph(30, 0.5);
      await browser.pause(300);
      const before = (await pageState(false))!;
      expect(before.top).toBe(30);

      await hideActiveTab();
      await moveHiddenTabToGroup();
      await waitForMovedPage(
        (state) =>
          state.readyState === "complete" && state.top === 30 && state.line === before.line,
        `its page at paragraph 30${mode === "split" ? ` and its source at line ${before.line}` : ""}`,
      );
      await browser.pause(500);
      expect(await pageState(true)).toMatchObject({ top: 30, line: before.line });
    });
  }

  // Obsidian lays the tab group out anew for Split down, and the hidden
  // tab's frame drops its document and loads its copy again with no size.
  // With the view as this change first had it, at 800babe, and as main at
  // c3411ee has it, the page then showed from its top, beside the split
  // view's source at line 37, on both versions.
  for (const mode of ["rendered", "split"] as const) {
    for (const closeAgain of [false, true]) {
      it(`keeps the ${mode} view's place where Split down in the tab in front reloads its hidden frame${closeAgain ? ", and that pane closes again" : ""} (#186)`, async function () {
        await writeParagraphsPage();
        await openInActiveTab(PARAGRAPHS);
        if (mode === "split") await clickToolbarButton("Split");
        await waitForPage();
        await scrollToParagraph(30, 0.5);
        await browser.pause(300);
        const before = (await pageState(false))!;
        expect(before.top).toBe(30);

        await hideActiveTab();
        // The premise: the frame dropped its document, once for each layout,
        // and has its next one, with no height.
        expect(await splitDownWhileHidden(closeAgain)).toEqual({
          reloads: closeAgain ? 2 : 1,
          height: 0,
        });
        await showHiddenTab();
        for (const wait of [0, 500]) {
          await browser.pause(wait);
          expect(await pageState(true)).toMatchObject({ top: 30, line: before.line });
        }
      });
    }
  }

  // The view restyles the page in place, and Chromium leaves it as far down
  // as it was, at another part: paragraph 38 in place of 30. With the view as
  // 800babe had it, the page went back to paragraph 30 when the tab showed
  // again, on both versions.
  it("stays where Readable line length moved its page's text while it showed (#182)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.pause(300);
    try {
      await setReadableLineLength(false);
      await browser.waitUntil(async () => ((await pageState(false))?.top ?? 30) > 32, {
        timeout: 5000,
        timeoutMsg: "the page did not take the pane's width",
      });
      await browser.pause(300);
      const before = (await pageState(false))!;

      await showTabAgain();
      await expectShownAgainAt(before);
    } finally {
      await setReadableLineLength(true);
    }
  });

  // With scroll anchoring off, Chromium leaves a page that narrows while it
  // shows as far down as it was, at another part. With the view as 800babe
  // had it, the page went back to paragraph 30 when the tab showed again.
  it("stays where its page went when it narrowed while it showed, without scroll anchoring (#182)", async function () {
    await writePage(
      PARAGRAPHS,
      "Long paragraphs",
      "<style>html, body { overflow-anchor: none }</style>\n",
      `${paragraphs(1, 60)}\n`,
    );
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Theme ON");
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.pause(300);
    await browser.executeObsidian(({ app }) => {
      app.workspace
        .getMostRecentLeaf()!
        .view.containerEl.querySelector<HTMLElement>(".view-content")!
        .style.setProperty("width", "500px");
    });
    await browser.waitUntil(async () => ((await pageState(false))?.top ?? 30) < 25, {
      timeout: 5000,
      timeoutMsg: "the narrowed page did not show another part",
    });
    await browser.pause(300);
    const before = (await pageState(false))!;

    await showTabAgain();
    await expectShownAgainAt(before);
  });

  it("keeps how far its page was scrolled sideways, where its view narrowed while the tab was hidden (#182)", async function () {
    await writeParagraphsPage(PARAGRAPHS, '<div style="width: 3000px; height: 1px"></div>');
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Theme ON");
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.execute((active) => {
      const win = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      )!.contentWindow!;
      win.scrollTo(300, win.scrollY);
    }, ACTIVE);
    await browser.pause(300);
    const before = (await pageState(false))!;
    expect(before).toMatchObject({ top: 30, scrollX: 300 });

    await showTabAgain({ width: 500 });
    await browser.pause(500);
    expect(await pageState(true)).toMatchObject({ top: 30, scrollX: 300 });
  });

  // The view measures what the page shows once its scrolling has settled.
  // Here the tab hides before then, and the page goes back to the pixel that
  // it was last reported at, not to paragraph 30, measured before.
  it("goes back as far down as its page was, where the tab hid while its scrolling had not settled (#182)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.pause(300);

    await showTabAgain({ scrolledTo: "p40" });
    await browser.pause(500);
    expect(await pageState(true)).toMatchObject({ top: 40 });
  });

  // The page's window reports Readable line length's change of its layout,
  // and the tab hides two frames later, before the view has measured the
  // page again. With a build that measures again but marks nothing out of
  // date, the page went back to paragraph 30 there.
  it("stays where Readable line length moved its page's text, where the tab hid two frames later (#182)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.pause(300);
    const before = (await pageState(false))!;
    expect(before.top).toBe(30);
    try {
      await showTabAgain({ readableLineLengthOff: true });
      for (const wait of [0, 500]) {
        await browser.pause(wait);
        const after = (await pageState(true))!;
        expect(after.scrollY).toBe(before.scrollY);
        expect(after.top).toBeGreaterThan(32);
      }
    } finally {
      await setReadableLineLength(true);
    }
  });

  // Showing the tab lays its page out anew, which the page's window reports
  // right after the view put the page back: that is no change of what it
  // shows. With the view as 0bdf231 had it, a tab shown for less than the
  // view's settling went back in pixels the next time, at another part of
  // a page that narrowed meanwhile.
  it("shows the part of its page that it showed, where it showed for a moment before its view narrowed while hidden (#182)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await clickToolbarButton("Theme ON");
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    await browser.pause(300);
    const before = (await pageState(false))!;
    expect(before.top).toBe(30);

    await hideActiveTab();
    const brief = await browser.executeObsidian(async ({ app }) => {
      const leaf = (
        window as unknown as {
          e2eShownAgain: { tabHeaderEl: HTMLElement; view: { containerEl: HTMLElement } };
        }
      ).e2eShownAgain;
      const front = app.workspace.getMostRecentLeaf() as unknown as { tabHeaderEl: HTMLElement };
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const task = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
      const iframe = leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe")!;
      await task();
      leaf.tabHeaderEl.click();
      const shownAt = performance.now();
      // The frame's observer puts the page back in the first frame, and the
      // page's window then reports the showing's layout.
      await frame();
      await frame();
      await task();
      front.tabHeaderEl.click();
      const shownFor = performance.now() - shownAt;
      for (let count = 0; iframe.clientHeight !== 0 && count < 120; count += 1) await frame();
      await frame();
      const hidden = iframe.clientHeight === 0;
      leaf.view.containerEl
        .querySelector<HTMLElement>(".view-content")!
        .style.setProperty("width", "500px");
      await frame();
      return { shownFor, hidden };
    });
    // The premise: shown for less than the view's settling of 100 ms.
    expect(brief.hidden).toBe(true);
    expect(brief.shownFor).toBeLessThan(100);

    await showHiddenTab();
    await browser.pause(500);
    const after = (await pageState(true))!;
    expect(after.text).toBeLessThan(before.text - 300);
    expect(after.top).toBe(30);
  });
});
