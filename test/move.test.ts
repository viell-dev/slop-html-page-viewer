import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import {
  keepPageScrolling,
  type NextDocumentFollowing,
  placeNextDocument,
  placeTop,
  type ReaderActivity,
  type ScrollPlace,
  scrollPlace,
  showPlace,
  watchHiding,
  watchReader,
} from "../src/scrolling";
import { ScrollFollower, type SideName } from "../src/split";
import { resizeObservers } from "./support/observers";

/**
 * A page laid out as its elements' `data-top` and `data-height` say, in page
 * pixels, scrolled down by `scrollY`, with what Chromium reports for parts
 * that it does not show:
 * - an element with `data-hidden`, and its content, have no box, as with
 *   `display: none`;
 * - an element with `display: contents` has no box, but its children do;
 * - the content of a closed `<details>` element keeps its box, since Chromium
 *   keeps it laid out, but `checkVisibility()` returns false for it.
 * An element's padding box is its whole box. jsdom lays nothing out itself,
 * and Obsidian's frames are measured in Obsidian (move.e2e.ts).
 */
function laidOut(body: string, scrollY: number): Document {
  const { window } = new JSDOM(`<!doctype html><html><body>${body}</body></html>`);
  Object.defineProperty(window, "scrollY", { configurable: true, value: scrollY });
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
  const boxless = (element: Element): boolean =>
    element.closest("[data-hidden]") !== null ||
    window.getComputedStyle(element).display === "contents";
  Object.defineProperty(window.Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      if (boxless(this)) return { top: 0, bottom: 0, height: 0, width: 0 };
      const top = Number(this.getAttribute("data-top") ?? 0) - scrollY;
      const height = Number(this.getAttribute("data-height") ?? 0);
      return { top, bottom: top + height, height, width: 100 };
    },
  });
  Object.defineProperty(window.Element.prototype, "getClientRects", {
    configurable: true,
    value(this: Element) {
      return boxless(this) ? [] : [this.getBoundingClientRect()];
    },
  });
  Object.defineProperty(window.Element.prototype, "checkVisibility", {
    configurable: true,
    value(this: Element) {
      return !boxless(this) && this.closest("details:not([open]) > :not(summary)") === null;
    },
  });
  Object.defineProperty(window.Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      // As in a browser, an inline box has no client area.
      if (window.getComputedStyle(this).display === "inline") return 0;
      return this.getBoundingClientRect().height;
    },
  });
  return window.document;
}

const PAGE = `<section data-top="0" data-height="900"><p data-top="0" data-height="900">One</p></section>
<section data-top="900" data-height="1000">
  <h2 data-top="900" data-height="100">Two</h2>
  <p data-top="1000" data-height="400">Two's first</p>
  <p data-top="1400" data-height="500">Two's second</p>
</section>`;

describe("a page's place across a move to another tab group or window (#126)", () => {
  it("is the innermost element at the window's top, and how far into it the top is", () => {
    assert.deepEqual(scrollPlace(laidOut(PAGE, 1100)), { path: [1, 1], into: 0.25, left: 0 });
  });

  it("passes over fixed and sticky elements, which are where the window is", () => {
    const doc = laidOut(
      `<header style="position: fixed" data-top="1100" data-height="50">Header</header>
<nav style="position: sticky" data-top="1100" data-height="50">Menu</nav>${PAGE}`,
      1100,
    );
    assert.deepEqual(scrollPlace(doc), { path: [3, 1], into: 0.25, left: 0 });
  });

  it("is in the element whose content holds the top, between its children", () => {
    // The top is in the space between the heading and the paragraph after it.
    const doc = laidOut(
      PAGE.replace('data-top="1000" data-height="400"', 'data-top="1100" data-height="300"'),
      1050,
    );
    assert.deepEqual(scrollPlace(doc), { path: [1], into: 0.15, left: 0 });
  });

  it("is nothing at the page's top", () => {
    assert.equal(scrollPlace(laidOut(PAGE, 0)), null);
  });

  it("is as far into the same element in a page laid out narrower", () => {
    const place = scrollPlace(laidOut(PAGE, 1100));
    assert.ok(place);
    // The same elements, wrapped onto more lines: twice as tall.
    assert.equal(placeTop(laidOut(narrower(PAGE), 0), place), 2200);
    assert.equal(placeTop(laidOut(narrower(PAGE), 300), place), 2200);
  });

  it("passes through an element with display: contents, as around a SvelteKit page", () => {
    const wrapped = `<div style="display: contents">${PAGE}</div>`;
    const place = scrollPlace(laidOut(wrapped, 1100));
    assert.deepEqual(place, { path: [0, 1, 1], into: 0.25, left: 0 });
    assert.equal(placeTop(laidOut(narrower(wrapped), 0), place), 2200);
  });

  it("falls back to the top of the deepest parent that the other document has", () => {
    assert.equal(placeTop(laidOut(PAGE, 0), { path: [1, 7, 2], into: 0.5, left: 0 }), 900);
  });

  it("shows a part that the other document hides with display: none from its top", () => {
    // The reader was in the second section's last paragraph, which the
    // document that the frame loads next hides, as a page's styles hide a
    // part that a checkbox opens.
    const place = scrollPlace(laidOut(PAGE, 1650));
    assert.deepEqual(place, { path: [1, 2], into: 0.5, left: 0 });
    const closed = PAGE.replace('<p data-top="1400"', '<p data-hidden data-top="1400"');
    assert.equal(placeTop(laidOut(closed, 0), place), 900);
  });

  it("shows a <details> element that the other document has closed from its top", () => {
    const open = `<p data-top="0" data-height="200">Before</p>
<details open data-top="200" data-height="820">
  <summary data-top="200" data-height="20">Details</summary>
  <p data-top="220" data-height="400">First inside</p>
  <p data-top="620" data-height="400">Second inside</p>
</details>
<p data-top="1020" data-height="2000">After</p>`;
    const place = scrollPlace(laidOut(open, 820));
    assert.deepEqual(place, { path: [1, 2], into: 0.5, left: 0 });
    // Closed, the element is its summary's height, and the paragraph after it
    // moves up; its content keeps the boxes it has inside the element.
    const closed = open
      .replace(
        '<details open data-top="200" data-height="820">',
        '<details data-top="200" data-height="20">',
      )
      .replace('<p data-top="1020"', '<p data-top="220"');
    assert.equal(placeTop(laidOut(closed, 0), place), 200);
  });

  it("shows a part that the other document clips to no height, or to less, from its top", () => {
    // jsdom reads overflow-y, but not the overflow shorthand that pages use.
    const open = `<p data-top="0" data-height="200">Before</p>
<div data-top="200" data-height="820">
  <label data-top="200" data-height="20">Accordion</label>
  <div style="overflow-y: hidden" data-top="220" data-height="800">
    <p data-top="220" data-height="400">First inside</p>
    <p data-top="620" data-height="400">Second inside</p>
  </div>
</div>
<p data-top="1020" data-height="2000">After</p>`;
    const place = scrollPlace(laidOut(open, 820));
    assert.deepEqual(place, { path: [1, 1, 1], into: 0.5, left: 0 });
    // Closed by a height limit of none, the panel keeps its content's boxes
    // but shows none of them: the panel is at the top, below its label.
    const closed = open
      .replace('<div data-top="200" data-height="820">', '<div data-top="200" data-height="20">')
      .replace('data-top="220" data-height="800"', 'data-top="220" data-height="0"')
      .replace('<p data-top="1020"', '<p data-top="220"');
    assert.equal(placeTop(laidOut(closed, 0), place), 220);
    // Limited to 300 pixels, the panel shows only the first paragraph's
    // beginning: the panel is at the top.
    const shorter = closed
      .replace('<div data-top="200" data-height="20">', '<div data-top="200" data-height="320">')
      .replace('data-top="220" data-height="0"', 'data-top="220" data-height="300"');
    assert.equal(placeTop(laidOut(shorter, 0), place), 220);
    // A place in what the panel still shows is kept.
    const inFirst: ScrollPlace = { path: [1, 1, 0], into: 0.25, left: 0 };
    assert.equal(placeTop(laidOut(shorter, 0), inFirst), 320);
    // A place in the part of that paragraph that the panel clips away shows
    // the paragraph, which begins in what the panel shows.
    const pastLimit: ScrollPlace = { path: [1, 1, 0], into: 0.9, left: 0 };
    assert.equal(placeTop(laidOut(shorter, 0), pastLimit), 220);
  });

  it("keeps a place inside an inline element whose overflow would clip", () => {
    const page = `<p data-top="0" data-height="200">Before</p>
<p data-top="200" data-height="800">
  <span style="display: inline; overflow-y: hidden" data-top="200" data-height="800">
    <em data-top="600" data-height="20">Deep inside</em>
  </span>
</p>`;
    const place: ScrollPlace = { path: [1, 0, 0], into: 0.5, left: 0 };
    assert.equal(placeTop(laidOut(page, 0), place), 610);
  });

  it("shows a closed panel where it is, also without an element of its own around it", () => {
    // The element around the panel is the body: its top is the page's top.
    const unwrapped = `<p data-top="0" data-height="2000">Before</p>
<label data-top="2000" data-height="20">Accordion</label>
<div style="overflow-y: hidden" data-top="2020" data-height="0">
  <p data-top="2020" data-height="400">First inside</p>
  <p data-top="2420" data-height="400">Second inside</p>
</div>
<p data-top="2020" data-height="2000">After</p>`;
    assert.equal(placeTop(laidOut(unwrapped, 0), { path: [2, 1], into: 0.5, left: 0 }), 2020);
  });
});

/** The same elements, wrapped onto more lines: twice as tall. */
function narrower(page: string): string {
  return page.replace(
    /data-(top|height)="(\d+)"/g,
    (_, name: string, value: string) => `data-${name}="${Number(value) * 2}"`,
  );
}

/**
 * A page of PAGE's layout that has its text but has not loaded, and the
 * heights that the view scrolls its window to.
 */
async function loadingPage(): Promise<{ doc: Document; scrolls: number[] }> {
  const doc = laidOut(PAGE, 0);
  const win = doc.defaultView!;
  // jsdom loads the page by itself, a moment after it is made.
  if (doc.readyState !== "complete")
    await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
  Object.defineProperty(doc, "readyState", { configurable: true, value: "interactive" });
  const scrolls: number[] = [];
  win.scrollTo = ((options: ScrollToOptions) => {
    scrolls.push(options.top ?? Number.NaN);
  }) as typeof win.scrollTo;
  return { doc, scrolls };
}

/** An element of the view, in Obsidian's own document, as its split view's source is. */
function viewElement(): HTMLElement {
  const { window } = new JSDOM(`<!doctype html><div class="view"><div>Source</div></div>`);
  return window.document.querySelector<HTMLElement>(".view")!;
}

const PLACE: ScrollPlace = { path: [1, 1], into: 0.25, left: 0 };

describe("placing a moved page again when it loads (#126)", () => {
  // The view's AbortController is its Obsidian window's, whose signals the
  // frame's window accepts as Chromium does; jsdom accepts only its own.
  Object.defineProperty(globalThis, "AbortController", {
    configurable: true,
    value: new JSDOM().window.AbortController,
  });

  it("places it at once, and again when it loads, once, without the reader's input", async () => {
    const { doc, scrolls } = await loadingPage();
    showPlace(doc, PLACE, [viewElement()], new AbortController().signal);
    assert.deepEqual(scrolls, [1100]);
    doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("load"));
    doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("load"));
    assert.deepEqual(scrolls, [1100, 1100]);
  });

  for (const type of ["keydown", "pointerdown", "touchstart", "wheel"]) {
    for (const where of ["the page", "the view"]) {
      it(`leaves it where it is when it loads after a ${type} in ${where}`, async () => {
        const { doc, scrolls } = await loadingPage();
        const view = viewElement();
        showPlace(doc, PLACE, [view], new AbortController().signal);
        const target = where === "the page" ? doc.querySelector("h2")! : view.firstElementChild!;
        const realm = target.ownerDocument.defaultView!;
        target.dispatchEvent(new realm.Event(type, { bubbles: true }));
        doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("load"));
        assert.deepEqual(scrolls, [1100]);
      });
    }
  }

  it("places it again when it loads after a modifier key only, which scrolls nothing (#167)", async () => {
    const { doc, scrolls } = await loadingPage();
    const view = viewElement();
    showPlace(doc, PLACE, [view], new AbortController().signal);
    for (const target of [doc.querySelector("h2")!, view.firstElementChild!]) {
      const realm = target.ownerDocument.defaultView!;
      for (const key of ["Control", "Shift", "Alt", "Meta"])
        target.dispatchEvent(new realm.KeyboardEvent("keydown", { bubbles: true, key }));
    }
    doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("load"));
    assert.deepEqual(scrolls, [1100, 1100]);
  });

  it("leaves it alone after the frame drops the document", async () => {
    const { doc, scrolls } = await loadingPage();
    const showing = new AbortController();
    showPlace(doc, PLACE, [viewElement()], showing.signal);
    showing.abort();
    doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("load"));
    assert.deepEqual(scrolls, [1100]);
  });

  it("places a page that has already loaded once", async () => {
    const { doc, scrolls } = await loadingPage();
    Object.defineProperty(doc, "readyState", { configurable: true, value: "complete" });
    showPlace(doc, PLACE, [viewElement()], new AbortController().signal);
    doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("load"));
    assert.deepEqual(scrolls, [1100]);
  });

  it("places it once, and not again when it loads, after the reader acted before it was shown (#157)", async () => {
    const { doc, scrolls } = await loadingPage();
    showPlace(doc, PLACE, [viewElement()], new AbortController().signal, { acted: true });
    doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("load"));
    assert.deepEqual(scrolls, [1100]);
  });

  it("says when placing it scrolls it, and not when it is there already (#157)", () => {
    for (const [from, moves] of [
      [0, 1],
      [1100, 0],
    ] as const) {
      const doc = laidOut(PAGE, from);
      const win = doc.defaultView!;
      // The window goes where it is sent at once, as Chromium's does.
      let scrollY: number = from;
      Object.defineProperty(win, "scrollY", { configurable: true, get: () => scrollY });
      win.scrollTo = ((options: ScrollToOptions) => {
        scrollY = options.top ?? scrollY;
      }) as typeof win.scrollTo;
      Object.defineProperty(doc, "readyState", { configurable: true, value: "complete" });
      let moved = 0;
      showPlace(doc, PLACE, [viewElement()], new AbortController().signal, {
        moved: () => (moved += 1),
      });
      assert.equal(scrollY, 1100);
      assert.equal(moved, moves, `placed from ${from}`);
    }
  });
});

describe("the reader's scrolling while the view shows no page (#157)", () => {
  /** The view and its split view's source, and a wait for the next task. */
  function view(): { view: HTMLElement; source: HTMLElement; nextTask: () => Promise<void> } {
    const element = viewElement();
    const win = element.ownerDocument.defaultView!;
    return {
      view: element,
      source: element.firstElementChild as HTMLElement,
      nextTask: () => new Promise((resolve) => win.setTimeout(resolve, 0)),
    };
  }

  function scroll(element: HTMLElement): void {
    element.dispatchEvent(new element.ownerDocument.defaultView!.Event("scroll"));
  }

  for (const type of ["keydown", "pointerdown", "touchstart", "wheel"]) {
    it(`counts a scroll of the source after a ${type} in the view`, async () => {
      const { view: element, source, nextTask } = view();
      const watch = watchReader(element, source);
      await nextTask();
      const realm = source.ownerDocument.defaultView!;
      source.dispatchEvent(new realm.Event(type, { bubbles: true }));
      scroll(source);
      assert.deepEqual(watch.stop(), { acted: true, scrolled: true });
    });
  }

  it("counts the reader's input without a scroll as acting only", async () => {
    const { view: element, source, nextTask } = view();
    const watch = watchReader(element, source);
    await nextTask();
    element.dispatchEvent(new element.ownerDocument.defaultView!.Event("keydown"));
    assert.deepEqual(watch.stop(), { acted: true, scrolled: false });
  });

  it("passes over a modifier key, which scrolls nothing, and counts the key that it changes (#167)", async () => {
    const { view: element, source, nextTask } = view();
    const watch = watchReader(element, source);
    await nextTask();
    const realm = source.ownerDocument.defaultView!;
    source.dispatchEvent(new realm.KeyboardEvent("keydown", { bubbles: true, key: "Control" }));
    scroll(source);
    assert.deepEqual(watch.stop(), { acted: false, scrolled: false });

    const next = watchReader(element, source);
    await nextTask();
    source.dispatchEvent(
      new realm.KeyboardEvent("keydown", { bubbles: true, key: "Home", ctrlKey: true }),
    );
    scroll(source);
    assert.deepEqual(next.stop(), { acted: true, scrolled: true });
  });

  it("passes over a scroll without the reader's input, as Obsidian 1.15.1 makes after a move", () => {
    const { view: element, source } = view();
    const watch = watchReader(element, source);
    scroll(source);
    assert.deepEqual(watch.stop(), { acted: false, scrolled: false });
  });

  it("passes over input that was still being dispatched when it started, as a hotkey that moved the tab", () => {
    const { view: element, source } = view();
    const watch = watchReader(element, source);
    source.dispatchEvent(new source.ownerDocument.defaultView!.Event("keydown", { bubbles: true }));
    scroll(source);
    assert.deepEqual(watch.stop(), { acted: false, scrolled: false });
  });

  it("counts nothing after it stops", async () => {
    const { view: element, source, nextTask } = view();
    const watch = watchReader(element, source);
    await nextTask();
    assert.deepEqual(watch.stop(), { acted: false, scrolled: false });
    source.dispatchEvent(new source.ownerDocument.defaultView!.Event("wheel", { bubbles: true }));
    scroll(source);
    assert.deepEqual(watch.stop(), { acted: false, scrolled: false });
  });
});

describe("showing the frame's next document after a move (#126, #157)", () => {
  /**
   * PAGE as the frame's next document, which has its text but has not loaded,
   * laid out as `laidOut` does at the height that its window is scrolled to,
   * and a split view's follower of it and of a source half its height, whose
   * frames run when `frame` says. The reader or Obsidian scrolls the source
   * with `scrollSource`, which Chromium reports only with `report`, and the
   * page with `scrollPage`. As the view's split view does, `split` passes
   * over the page's reports while the page follows the source (#195).
   */
  async function nextDocument() {
    const doc = laidOut(PAGE, 0);
    const win = doc.defaultView!;
    if (doc.readyState !== "complete")
      await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
    Object.defineProperty(doc, "readyState", { configurable: true, value: "interactive" });
    let scrollY = 0;
    Object.defineProperty(win, "scrollY", { configurable: true, get: () => scrollY });
    Object.defineProperty(win.Element.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element) {
        const top = Number(this.getAttribute("data-top") ?? 0) - scrollY;
        const height = Number(this.getAttribute("data-height") ?? 0);
        return { top, bottom: top + height, height, width: 100 };
      },
    });
    const page: number[] = [];
    win.scrollTo = ((options: ScrollToOptions) => {
      scrollY = options.top ?? scrollY;
      page.push(scrollY);
    }) as typeof win.scrollTo;
    let sourceTop = 0;
    const source: number[] = [];
    const frames: (() => void)[] = [];
    const follower = new ScrollFollower(
      {
        source: {
          position: () => sourceTop,
          furthest: () => 10_000,
          scrollTo: (to) => {
            sourceTop = to;
            source.push(to);
          },
        },
        page: {
          position: () => scrollY,
          furthest: () => 20_000,
          scrollTo: (to) => win.scrollTo({ top: to }),
        },
      },
      { source: (top) => top * 2, page: (top) => top / 2 },
      (run) => frames.push(run),
    );
    let pageFollows: AbortSignal | null = null;
    const split: NextDocumentFollowing = {
      follower,
      sourceLeads: (until) => {
        pageFollows = until;
        follower.placed("source");
      },
    };
    return {
      doc,
      follower,
      split,
      /** Where the follower and the view scrolled the page and the source to. */
      scrolls: { page, source },
      scrollSource: (to: number) => {
        sourceTop = to;
      },
      scrollPage: (to: number) => {
        scrollY = to;
      },
      report: (side: SideName) => {
        if (side === "source" || pageFollows === null || pageFollows.aborted)
          follower.scrolled(side);
      },
      frame: () => {
        for (const run of frames.splice(0)) run();
      },
      load: () => win.dispatchEvent(new win.Event("load")),
    };
  }

  const show = (
    next: Awaited<ReturnType<typeof nextDocument>>,
    reader: ReaderActivity | null,
    place: ScrollPlace | null = PLACE,
    led: SideName | null = null,
    others: readonly EventTarget[] = [viewElement()],
  ): ScrollPlace | undefined =>
    placeNextDocument(
      next.doc,
      { place, led },
      reader,
      next.split,
      others,
      new AbortController().signal,
    );

  for (const place of [PLACE, null]) {
    it(`lets the page follow a scroll of the source that the reader made while no page showed, ${place ? "from a place" : "from its top"}`, async () => {
      const next = await nextDocument();
      next.scrollSource(300);
      show(next, { acted: true, scrolled: true }, place);
      next.frame();
      assert.deepEqual(next.scrolls.page, [600], "the page follows the source, unplaced");
      next.load();
      assert.deepEqual(next.scrolls.page, [600], "and is not placed when it loads");
    });
  }

  it("lets a scroll of the source lead that the reader made before the page showed, and that comes after it", async () => {
    // As with keys or the scroll bar: the reader's input before the page
    // shows, and Chromium's report of the scroll only after it is placed.
    const next = await nextDocument();
    next.scrollSource(300);
    show(next, { acted: true, scrolled: false });
    assert.deepEqual(next.scrolls.page, [1100], "placed");
    next.report("source");
    next.report("page");
    next.frame();
    assert.deepEqual(next.scrolls.page, [1100, 600], "the page follows the source");
    assert.deepEqual(next.scrolls.source, [], "the source is not sent back");
    next.load();
    assert.deepEqual(next.scrolls.page, [1100, 600], "and is not placed again when it loads");
  });

  it("passes over Obsidian's scroll of the source without the reader's input, and lets the placed page lead", async () => {
    const next = await nextDocument();
    // Obsidian 1.15.1 scrolls the moved source back itself; Chromium can
    // report it after the page is placed.
    next.scrollSource(300);
    show(next, { acted: false, scrolled: false });
    next.report("source");
    next.report("page");
    next.frame();
    assert.deepEqual(next.scrolls.source, [550], "the source follows the placed page");
    next.load();
    assert.deepEqual(next.scrolls.page, [1100, 1100], "placed again when it loads");
  });

  it("lets a scroll of the reader's lead that the source reports in the frame of the placement", async () => {
    const next = await nextDocument();
    show(next, { acted: false, scrolled: false });
    next.scrollSource(300);
    next.report("source");
    next.report("page");
    next.frame();
    assert.deepEqual(next.scrolls.page, [1100, 600], "the page follows the source");
    assert.deepEqual(next.scrolls.source, [], "the source is not sent back");
  });

  it("places the page without the split view, and not again when it loads after the reader's input", async () => {
    const next = await nextDocument();
    placeNextDocument(
      next.doc,
      { place: PLACE, led: "source" },
      { acted: true, scrolled: true },
      null,
      [viewElement()],
      new AbortController().signal,
    );
    next.load();
    assert.deepEqual(next.scrolls.page, [1100]);
  });

  // Where the source led last, it keeps its line, where its kept place has
  // put it back, and the page follows it there: were the placed page to lead,
  // the lines that share its first pixels, as a long head's, would map to
  // another one (#195).
  it("has the source that led last lead from where it is, and the page follow it, also when the page loads (#195)", async () => {
    const next = await nextDocument();
    next.scrollSource(300);
    assert.equal(show(next, { acted: false, scrolled: false }, PLACE, "source"), undefined);
    assert.deepEqual(next.scrolls.page, [], "the page is not placed");
    next.frame();
    assert.deepEqual(next.scrolls.page, [600], "it follows the source");
    // Chromium's scroll anchoring moves the page as its images load, which
    // leads nothing.
    next.report("page");
    next.scrollPage(650);
    next.report("page");
    next.frame();
    assert.deepEqual(next.scrolls, { page: [600], source: [] });
    next.load();
    next.frame();
    assert.deepEqual(next.scrolls.page, [600, 600], "and follows it again when it loads");
    // The page's own scrolling leads again after that.
    next.scrollPage(800);
    next.report("page");
    next.frame();
    assert.deepEqual(next.scrolls.source, [400]);
  });

  it("lets the page lead that the reader scrolls before it loads, where the source led last (#195)", async () => {
    const next = await nextDocument();
    const view = viewElement();
    next.scrollSource(300);
    show(next, { acted: false, scrolled: false }, PLACE, "source", [view]);
    next.frame();
    const viewWindow = view.ownerDocument.defaultView!;
    view.dispatchEvent(new viewWindow.WheelEvent("wheel", { bubbles: true, deltaY: 200 }));
    next.scrollPage(800);
    next.report("page");
    next.frame();
    assert.deepEqual(next.scrolls.source, [400], "the source follows the reader's page");
    next.load();
    next.frame();
    assert.deepEqual(next.scrolls.page, [600], "and the page is not sent back when it loads");
  });

  it("has the source lead once where it led last and the reader acted while no page showed (#195)", async () => {
    const next = await nextDocument();
    next.scrollSource(300);
    show(next, { acted: true, scrolled: false }, PLACE, "source");
    next.frame();
    next.scrollPage(650);
    next.report("page");
    next.frame();
    assert.deepEqual(next.scrolls.source, [325], "the page's scroll is theirs");
    next.load();
    next.frame();
    assert.deepEqual(next.scrolls.page, [600]);
  });

  it("places the page that led last where the previous document was, as before any side led (#195)", async () => {
    for (const led of ["page", null] as const) {
      const next = await nextDocument();
      next.scrollSource(300);
      show(next, { acted: false, scrolled: false }, PLACE, led);
      next.report("source");
      next.frame();
      assert.deepEqual(next.scrolls, { page: [1100], source: [550] }, String(led));
    }
  });

  it("says which place it shows the page at: the previous one's, or none where there is none or the page follows the source (#186)", async () => {
    const next = await nextDocument();
    assert.equal(show(next, { acted: false, scrolled: false }), PLACE);
    assert.equal(show(next, { acted: true, scrolled: true }), undefined);
    assert.equal(show(next, null, null), undefined);
    assert.equal(show(next, { acted: false, scrolled: false }, PLACE, "source"), undefined);
    assert.equal(
      placeNextDocument(
        next.doc,
        { place: PLACE, led: null },
        { acted: true, scrolled: true },
        null,
        [viewElement()],
        new AbortController().signal,
      ),
      PLACE,
      "without the split view, the page has no source to follow",
    );
  });

  it("leaves a first document, and one whose previous document was at its top, where it is", async () => {
    for (const reader of [null, { acted: false, scrolled: false }]) {
      const next = await nextDocument();
      show(next, reader, null);
      next.report("source");
      next.frame();
      next.load();
      assert.deepEqual(next.scrolls, { page: [], source: [] });
    }
  });
});

/**
 * A frame in an Obsidian window, with that window's ResizeObservers, which
 * `report` runs, and a page in the frame, as jsdom lays neither out: the
 * frame 400 pixels high, and the page's window scrolled down by `scrollY`
 * and sideways by `scrollX`. The page's two paragraphs, `One` and `Two`, are
 * each `layout.height` pixels high, 1000 to start with: a narrower frame lays
 * them out higher. The page's root is as high as both. The page's own window
 * has ResizeObservers too, which `reportPage` runs, as for the sizes of its
 * root and body; Chromium runs the frame's window's first.
 *
 * `scroll` scrolls the page and reports it, as Chromium does in its next
 * frame, and `jump` scrolls it without a report; `scrolledTo` collects
 * where its scrollTo sends it, which reports nothing. `hide` does what
 * Chromium does when Obsidian hides the tab with `display: none`: the frame
 * has no size, its page has no boxes, and it goes to its start and reports
 * that; then the windows' observers report. `show` lays the frame out
 * again, and they report. The page has animation frames, which run when
 * `nextFrame` says, each 1000 / 60 ms after the one before; `settle` runs
 * those of 150 ms.
 */
function framedPage() {
  const owner = new JSDOM("<!doctype html><html><body></body></html>").window;
  const { observers, report } = resizeObservers(owner as unknown as Window);
  const frame = owner.document.createElement("iframe");
  owner.document.body.append(frame);
  const doc = new JSDOM("<!doctype html><html><body><p>One</p><p>Two</p></body></html>", {
    url: "about:srcdoc",
  }).window.document;
  const win = doc.defaultView!;
  const page = resizeObservers(win);
  let height = 400;
  let scrollY = 0;
  let scrollX = 0;
  const layout = { height: 1000 };
  Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => doc });
  Object.defineProperty(frame, "clientHeight", { configurable: true, get: () => height });
  Object.defineProperties(doc.documentElement, {
    scrollHeight: { configurable: true, get: () => 2 * layout.height },
    clientHeight: { configurable: true, get: () => height },
  });
  Object.defineProperty(win, "scrollY", { configurable: true, get: () => scrollY });
  Object.defineProperty(win, "scrollX", { configurable: true, get: () => scrollX });
  Object.defineProperty(win.Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      if (height === 0) return { top: 0, bottom: 0, height: 0, width: 0 };
      const index = this.localName === "p" ? [...doc.body.children].indexOf(this) : 0;
      const tall = this.localName === "p" ? layout.height : 2 * layout.height;
      const top = index * layout.height - scrollY;
      return { top, bottom: top + tall, height: tall, width: 100 };
    },
  });
  Object.defineProperty(win.Element.prototype, "getClientRects", {
    configurable: true,
    value(this: Element) {
      return height === 0 ? [] : [this.getBoundingClientRect()];
    },
  });
  const scrolledTo: number[] = [];
  const scrolledSideways: number[] = [];
  win.scrollTo = ((options: ScrollToOptions) => {
    scrollY = options.top ?? scrollY;
    scrollX = options.left ?? scrollX;
    scrolledTo.push(scrollY);
    scrolledSideways.push(scrollX);
  }) as typeof win.scrollTo;
  const callbacks: FrameRequestCallback[] = [];
  win.requestAnimationFrame = (callback) => callbacks.push(callback);
  let time = 0;
  const nextFrame = (): void => {
    time += 1000 / 60;
    for (const callback of callbacks.splice(0)) callback(time);
  };
  const scroll = (to: number, sideways = scrollX): void => {
    scrollY = to;
    scrollX = sideways;
    doc.dispatchEvent(new win.Event("scroll", { bubbles: true }));
  };
  const reportAll = (): void => {
    report();
    page.report();
  };
  return {
    owner,
    frame,
    doc,
    layout,
    observers,
    report,
    reportPage: page.report,
    pageObservers: page.observers,
    scrolledTo,
    scrolledSideways,
    scroll,
    jump: (to: number): void => {
      scrollY = to;
    },
    hide: (): void => {
      height = 0;
      scroll(0, 0);
      reportAll();
    },
    show: (): void => {
      height = 400;
      reportAll();
    },
    /** Lays the frame out again before its window's observers report. */
    layOut: (): void => {
      height = 400;
    },
    nextFrame,
    settle: (): void => {
      for (let count = 0; count < 9; count += 1) nextFrame();
    },
    signal: () => new owner.AbortController().signal,
  };
}

describe("watching Obsidian hide a frame's tab and show it again (#178)", () => {
  /** Watches `page`'s frame, and lists what it was told. */
  function watched(page: ReturnType<typeof framedPage>, signal = page.signal()): string[] {
    const told: string[] = [];
    watchHiding(page.frame, page.doc, signal, {
      hid: () => told.push("hid"),
      shown: () => told.push("shown"),
    });
    return told;
  }

  it("tells when the frame's own window lays it out with no size, and with a size again", () => {
    const page = framedPage();
    const told = watched(page);
    assert.equal(page.observers.length, 1, "an observer of the frame's own window");
    assert.deepEqual(page.observers[0].observed, [page.frame]);
    // A window's first report gives the size that the frame has then.
    page.report();
    assert.deepEqual(told, []);
    page.hide();
    page.report();
    assert.deepEqual(told, ["hid"]);
    page.show();
    page.report();
    assert.deepEqual(told, ["hid", "shown"]);
    page.hide();
    page.show();
    assert.deepEqual(told, ["hid", "shown", "hid", "shown"]);
  });

  it("tells nothing at a resize of a frame that shows", () => {
    const page = framedPage();
    const told = watched(page);
    page.report();
    assert.deepEqual(told, []);
  });

  it("takes a frame that has no size when watched for hidden", () => {
    const page = framedPage();
    page.hide();
    const told = watched(page);
    assert.deepEqual(told, ["hid"]);
    page.show();
    assert.deepEqual(told, ["hid", "shown"]);
  });

  it("takes a frame that shows another document for hidden", () => {
    const page = framedPage();
    const told = watched(page);
    Object.defineProperty(page.frame, "contentDocument", {
      configurable: true,
      value: new JSDOM("").window.document,
    });
    page.report();
    assert.deepEqual(told, ["hid"]);
  });

  it("tells nothing after its signal, nor in a window without ResizeObserver", () => {
    const page = framedPage();
    const showing = new page.owner.AbortController();
    const told = watched(page, showing.signal);
    showing.abort();
    assert.equal(page.observers[0].connected, false);
    page.hide();
    page.show();
    assert.deepEqual(told, []);
    assert.deepEqual(watched(page, showing.signal), []);
    assert.equal(page.observers.length, 1, "nothing is observed after the signal aborted");

    const bare = framedPage();
    delete (bare.owner as { ResizeObserver?: unknown }).ResizeObserver;
    bare.hide();
    assert.deepEqual(watched(bare), []);
  });
});

describe("a page's place when Obsidian hides its tab and shows it again (#178)", () => {
  /** Keeps `page`'s place, held while its frame is hidden and back when it shows, as the view does. */
  function kept(page: ReturnType<typeof framedPage>) {
    const place = keepPageScrolling(page.frame, page.doc, page.signal())!;
    watchHiding(page.frame, page.doc, page.signal(), {
      hid: () => place.hold(),
      shown: () => place.back(),
    });
    page.report();
    return place;
  }

  it("goes back to where it was as soon as its frame's window lays the frame out again", () => {
    const page = framedPage();
    kept(page);
    page.scroll(900);
    page.hide();
    assert.deepEqual(page.scrolledTo, [], "a hidden frame has nothing to scroll");
    page.show();
    assert.deepEqual(page.scrolledTo, [900]);
    page.report();
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, [900, 900], "and again after it was hidden again");
  });

  it("stays where the reader scrolled it, also at its start", () => {
    const page = framedPage();
    kept(page);
    page.scroll(900);
    page.scroll(0);
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, []);
  });

  it("keeps no scroll that is reported while held, as one that comes as its frame shows again", () => {
    const page = framedPage();
    kept(page);
    page.scroll(900);
    page.hide();
    // Chromium lays the frame out somewhere and reports that, and only then
    // do the frame's window's observers report.
    page.layOut();
    page.scroll(40);
    page.report();
    assert.deepEqual(page.scrolledTo, [900]);
  });

  // As where the reader scrolls a moved split view's source before the frame
  // shows its next document (#157, #189).
  it("keeps a scroll that it reports while held in the frame of the reader's input in it, which ends the hold", () => {
    const page = framedPage();
    const place = keepPageScrolling(page.frame, page.doc, page.signal())!;
    page.scroll(900);
    place.hold();
    page.scroll(600);
    page.doc.body.dispatchEvent(new page.doc.defaultView!.WheelEvent("wheel", { bubbles: true }));
    page.scroll(300);
    page.scroll(200);
    page.hide();
    place.hold();
    page.show();
    place.back();
    assert.deepEqual(page.scrolledTo, [200]);
  });

  it("is not sent back where the reader's input in the page scrolled it before Chromium reported it", () => {
    const page = framedPage();
    kept(page);
    page.scroll(900);
    page.doc.body.dispatchEvent(new page.doc.defaultView!.WheelEvent("wheel", { bubbles: true }));
    page.jump(0);
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, [], "not while the scroll is unreported");
    page.nextFrame();
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, [900], "but once Chromium's next frame has passed");
  });

  it("goes back to where the view scrolled it itself, as the find bar does", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.jump(300);
    place.placed();
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, [300]);
  });

  it("keeps where it is once released, as where the reader scrolled it while held", () => {
    const page = framedPage();
    const place = keepPageScrolling(page.frame, page.doc, page.signal())!;
    page.scroll(900);
    place.hold();
    page.scroll(600);
    place.release();
    page.hide();
    place.hold();
    page.show();
    place.back();
    assert.deepEqual(page.scrolledTo, [600]);
  });
});

describe("what a page shows when Obsidian shows its tab again at another width (#182)", () => {
  /**
   * Keeps `page`'s place, held while its frame is hidden and back when it
   * shows, as the view does, starting from `shown`, and the windows' first
   * reports of the sizes that they observe.
   */
  function kept(page: ReturnType<typeof framedPage>, shown?: ScrollPlace) {
    const place = keepPageScrolling(page.frame, page.doc, page.signal(), shown)!;
    watchHiding(page.frame, page.doc, page.signal(), {
      hid: () => place.hold(),
      shown: () => place.back(),
    });
    page.report();
    page.reportPage();
    return place;
  }

  it("shows the element that was at its top, as laid out now", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.settle();
    assert.deepEqual(place.place(), { path: [0], into: 0.9, left: 0 });
    page.hide();
    // As where the frame narrowed while hidden: its paragraphs wrap onto
    // about twice as many lines.
    page.layout.height = 2000.5;
    page.show();
    assert.deepEqual(page.scrolledTo, [1800], "to the pixel");
  });

  it("measures the element at its top only once 100 ms of frames pass without a report of its scrolling", () => {
    const page = framedPage();
    const place = kept(page);
    // A scroll in steps, with five frames between them.
    for (const to of [900, 1000, 1100, 1200]) {
      page.scroll(to);
      for (let count = 0; count < 5; count += 1) page.nextFrame();
    }
    assert.equal(place.place(), undefined, "not between the steps");
    page.nextFrame();
    page.nextFrame();
    assert.deepEqual(place.place(), { path: [1], into: 0.2, left: 0 });
    page.hide();
    page.layout.height = 2000;
    page.show();
    assert.deepEqual(page.scrolledTo, [2400]);
  });

  it("goes back as far down as it was last reported, where its scrolling had not settled when its frame hid", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.settle();
    page.scroll(1200);
    page.nextFrame();
    page.hide();
    page.settle();
    assert.deepEqual(place.place(), { path: [0], into: 0.9, left: 0 }, "nothing measured hidden");
    page.layout.height = 2000;
    page.show();
    assert.deepEqual(page.scrolledTo, [1200], "not to paragraph One");
  });

  it("goes back exactly where it was, where what it showed is less than a pixel from there", () => {
    const page = framedPage();
    kept(page);
    page.scroll(901);
    page.settle();
    page.hide();
    // 0.901 of One is 901.6 pixels down now.
    page.layout.height = 1000.666;
    page.show();
    assert.deepEqual(page.scrolledTo, [901]);
  });

  it("goes back as far sideways as it was", () => {
    const page = framedPage();
    kept(page);
    page.scroll(900, 300);
    page.settle();
    page.hide();
    page.layout.height = 2000;
    page.show();
    assert.deepEqual(page.scrolledTo, [1800]);
    assert.deepEqual(page.scrolledSideways, [300]);
  });

  // Obsidian puts the elements of a tab that it moves back as far down as
  // they were, not its frame's page, which the frame loads anew (#189).
  it("takes a scroll that leaves it as far down as it was last reported for its own", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.settle();
    page.layout.height = 2000;
    page.scroll(900);
    assert.deepEqual(page.scrolledTo, []);
    page.settle();
    assert.deepEqual(place.place(), { path: [0], into: 0.45, left: 0 });
  });

  it("shows what the view scrolled it to itself, as the find bar does, and what the reader scrolled it to while held", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.settle();
    page.jump(300);
    place.placed();
    page.settle();
    assert.deepEqual(place.place(), { path: [0], into: 0.3, left: 0 });
    place.hold();
    page.jump(1500);
    place.release();
    page.settle();
    assert.deepEqual(place.place(), { path: [1], into: 0.5, left: 0 });
    page.hide();
    page.layout.height = 2000;
    page.show();
    assert.deepEqual(page.scrolledTo, [3000]);
  });

  it("says that it is at its top, and that it does not know before it has measured", () => {
    const page = framedPage();
    const place = kept(page);
    assert.equal(place.place(), undefined);
    page.scroll(900);
    page.settle();
    page.scroll(0);
    page.settle();
    assert.equal(place.place(), null);
  });

  // As where Obsidian's Readable line length is turned off while the tab
  // shows, or a page without scroll anchoring narrows: the same pixels show
  // another part, with no report.
  it("goes back to the pixel where its layout changed while it showed, until it measures again", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.settle();
    page.layout.height = 500;
    page.reportPage();
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, [900], "not to paragraph One's 450 px");

    page.settle();
    assert.deepEqual(place.place(), { path: [1], into: 0.8, left: 0 }, "Two, measured again");
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, [900, 900]);
  });

  it("takes no report of its frame's hiding or showing for a change of its layout", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.settle();
    page.hide();
    page.settle();
    page.layout.height = 2000;
    page.show();
    assert.deepEqual(page.scrolledTo, [1800]);
    // The page's window reports the sizes that showing it changed, after
    // the frame's window: it measures again, at its place.
    page.settle();
    assert.deepEqual(place.place(), { path: [0], into: 0.9, left: 0 });
  });

  // Showing the frame lays its page out anew, and the page's window reports
  // that after `back`, in the same frame: nothing that the page shows
  // changed. A tab shown for less than the settling, as one passed over
  // with a held key, keeps what it showed.
  it("keeps what it showed through a show shorter than its settling, also at another width", () => {
    const page = framedPage();
    const place = kept(page);
    page.scroll(900);
    page.settle();
    page.hide();
    page.show();
    page.nextFrame();
    page.nextFrame();
    page.hide();
    page.layout.height = 2000;
    page.show();
    assert.deepEqual(page.scrolledTo, [900, 1800], "paragraph One, as far into it as it was");

    // Shown at that width only briefly: Chromium reports the going back,
    // where it shows the same element.
    page.scroll(1800);
    page.nextFrame();
    page.hide();
    page.layout.height = 3000;
    page.show();
    assert.deepEqual(page.scrolledTo, [900, 1800, 2700]);
    assert.deepEqual(place.place(), { path: [0], into: 0.9, left: 0 });
  });

  it("takes a change of layout in the frame after its showing for one", () => {
    const page = framedPage();
    kept(page);
    page.scroll(900);
    page.settle();
    page.hide();
    page.show();
    page.nextFrame();
    // As Readable line length turned off: the same pixels show another part.
    page.layout.height = 500;
    page.reportPage();
    page.hide();
    page.show();
    assert.deepEqual(page.scrolledTo, [900, 900]);
  });

  it("shows the place that the view shows it at once its frame has a size, as where it had none at first (#186)", () => {
    const page = framedPage();
    page.hide();
    const place = kept(page, { path: [1], into: 0.25, left: 0 });
    assert.deepEqual(place.place(), { path: [1], into: 0.25, left: 0 });
    page.show();
    assert.deepEqual(page.scrolledTo, [1250]);
  });

  it("observes its page's root and body in the page's own window, until its signal", () => {
    const page = framedPage();
    const showing = new page.owner.AbortController();
    keepPageScrolling(page.frame, page.doc, showing.signal);
    assert.equal(page.pageObservers.length, 1);
    assert.deepEqual(page.pageObservers[0].observed, [page.doc.documentElement, page.doc.body]);
    showing.abort();
    assert.equal(page.pageObservers[0].connected, false);
  });
});
