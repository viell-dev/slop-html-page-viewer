import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import {
  placeNextDocument,
  placeTop,
  type ReaderActivity,
  type ScrollPlace,
  scrollPlace,
  showPlace,
  watchReader,
} from "../src/scrolling";
import { ScrollFollower } from "../src/split";

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
   * with `scrollSource`, which Chromium reports only with `report`.
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
    return {
      doc,
      follower,
      /** Where the follower and the view scrolled the page and the source to. */
      scrolls: { page, source },
      scrollSource: (to: number) => {
        sourceTop = to;
      },
      report: (side: "source" | "page") => follower.scrolled(side),
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
  ): void =>
    placeNextDocument(
      next.doc,
      place,
      reader,
      next.follower,
      [viewElement()],
      new AbortController().signal,
    );

  it("lets the page follow a scroll of the source that the reader made while no page showed", async () => {
    const next = await nextDocument();
    next.scrollSource(300);
    show(next, { acted: true, scrolled: true });
    next.frame();
    assert.deepEqual(next.scrolls.page, [600], "the page follows the source, unplaced");
    next.load();
    assert.deepEqual(next.scrolls.page, [600], "and is not placed when it loads");
  });

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
      PLACE,
      { acted: true, scrolled: true },
      null,
      [viewElement()],
      new AbortController().signal,
    );
    next.load();
    assert.deepEqual(next.scrolls.page, [1100]);
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
