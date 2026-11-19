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
 * if no window opened.
 */
async function holdNewWindowStyles(number: number, reader?: ReaderLine): Promise<void> {
  await browser.execute(
    (number, reader) => {
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
              ".html-page-viewer__split .html-page-viewer__source",
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
              state.followed = root !== null && root.dataset.e2eBefore === undefined && at(number);
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

/**
 * Opens a new tab in the active tab's tab group, which hides the active tab
 * with `display: none` while it shows, and then shows the active tab again by
 * clicking its tab header, as the reader does (#178). The tab's frame, if it
 * has one, is marked as moveActiveTab marks it, for pageState(true) to find,
 * and so is its source, for movedSource.
 */
async function showTabAgain(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    const leaf = app.workspace.getMostRecentLeaf()!;
    leaf.view.containerEl.querySelector("iframe")?.setAttribute("data-e2e-moved", "");
    leaf.view.containerEl
      .querySelector(".html-page-viewer__source")
      ?.setAttribute("data-e2e-moved", "");
    (window as unknown as { e2eShownAgain: typeof leaf }).e2eShownAgain = leaf;
    app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true });
  });
  const displayed = (): Promise<boolean> =>
    browser.execute(() => {
      const leaf = (window as unknown as { e2eShownAgain: { containerEl: HTMLElement } })
        .e2eShownAgain;
      return getComputedStyle(leaf.containerEl).display !== "none";
    });
  await browser.waitUntil(async () => !(await displayed()), {
    timeout: 5000,
    timeoutMsg: "Obsidian did not hide the tab",
  });
  // Chromium reports the hidden page's scroll in its next frame.
  await nextFrames();
  const header = await browser.execute(() => {
    const leaf = (window as unknown as { e2eShownAgain: { tabHeaderEl: HTMLElement } })
      .e2eShownAgain;
    const box = leaf.tabHeaderEl.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  });
  await browser.action("pointer").move(header).down().up().perform();
  await browser.waitUntil(displayed, { timeout: 5000, timeoutMsg: "the tab did not show again" });
  await nextFrames();
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

/**
 * Checks that the split view of openLongPageSplitAtLine30, shown again, has
 * its page where it was, `before`, and its sides in step at line 30 and
 * paragraph 22, and that they stay there.
 */
async function expectSplitShownAgainAt(before: PageState): Promise<void> {
  for (const wait of [0, 500]) {
    await browser.pause(wait);
    const after = (await pageState(true))!;
    expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
    expect(Math.abs((after.line ?? 0) - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.top - 22)).toBeLessThanOrEqual(1);
  }
}

describe("A tab shown again after another tab of its tab group in Obsidian", function () {
  beforeEach(freshTab);

  it("shows its page where it was (#178)", async function () {
    await writeParagraphsPage();
    await openInActiveTab(PARAGRAPHS);
    await waitForPage();
    await scrollToParagraph(30, 0.5);
    const before = (await pageState(false))!;
    expect(before).toMatchObject({ top: 30 });

    await showTabAgain();
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
    await nextFrames();

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
    await nextFrames();
    const before = (await pageState(false))!;

    await showTabAgain();
    await expectShownAgainAt(before);
    const count = await browser.execute(
      (active) => document.querySelector(`${active} .html-page-viewer__find-count`)?.textContent,
      ACTIVE,
    );
    expect(count).toBe("1 of 1");
  });

  it("keeps the split view's sides where they were, in step (#178)", async function () {
    await openLongPageSplitAtLine30();
    await nextFrames();
    const before = (await pageState(false))!;

    await showTabAgain();
    await expectSplitShownAgainAt(before);
  });

  // As a quick switch to another tab and back does, a moment after the
  // reader's last scroll. The view measures the sides again when their sizes
  // have changed, at most once every 250 ms, and a measurement of the hidden
  // sides would last until 250 ms after it.
  it("keeps the split view's sides in step when its tab shows again at once (#178)", async function () {
    await openLongPageSplitAtLine30();
    await browser.pause(500);
    const before = (await pageState(false))!;

    const hidden = await browser.executeObsidian(async ({ app }) => {
      const leaf = app.workspace.getMostRecentLeaf()!;
      leaf.view.containerEl.querySelector("iframe")!.setAttribute("data-e2e-moved", "");
      const frame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const started = performance.now();
      app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true });
      // Chromium reports the hidden page's scroll in its next frame, and the
      // view would follow it in the frame after.
      for (let count = 0; count < 4; count += 1) await frame();
      const pageY = leaf.view.containerEl.querySelector("iframe")!.contentWindow!.scrollY;
      app.workspace.setActiveLeaf(leaf, { focus: true });
      return { pageY, hiddenFor: performance.now() - started };
    });
    // The premise: Chromium scrolled the hidden page to its start.
    expect(hidden.pageY).toBe(0);
    expect(hidden.hiddenFor).toBeLessThan(250);
    await nextFrames();
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
    await nextFrames();

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
    await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      )!.contentDocument!;
      const column = doc.getElementById("column")!;
      column.scrollTop = doc.getElementById("p30")!.offsetTop;
    }, ACTIVE);
    await nextFrames();
    const column = async (): Promise<number | null> =>
      browser.executeObsidian(({ app }) => {
        let top: number | null = null;
        app.workspace.iterateAllLeaves((leaf) => {
          const element = leaf.view.containerEl
            .querySelector<HTMLIFrameElement>("iframe[data-e2e-moved]")
            ?.contentDocument?.getElementById("column");
          if (element) top = element.scrollTop;
        });
        return top;
      });
    const before = await browser.execute(
      (active) =>
        document
          .querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`)!
          .contentDocument!.getElementById("column")!.scrollTop,
      ACTIVE,
    );
    expect(before).toBeGreaterThan(1000);

    await showTabAgain();
    await browser.pause(500);
    expect(await column()).toBe(before);
  });
});
