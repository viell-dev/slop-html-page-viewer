// Scrolling the page in the view's frame: at once, past the page's own smooth
// scrolling, and back to where the frame's previous document of the same copy
// was when its tab moved to another tab group or window (#126).

/**
 * Scrolls a window or an element at once, also in a page whose own style
 * scrolls smoothly, which would move it in steps that each report a scroll. A
 * Chromium that does not know "instant" throws; then the style of the page's
 * `root` is set aside for the move.
 */
export function scrollInstantly(
  target: Element | Window,
  root: HTMLElement,
  to: ScrollToOptions,
): void {
  try {
    target.scrollTo({ ...to, behavior: "instant" as ScrollBehavior });
  } catch {
    const saved = root.style.getPropertyValue("scroll-behavior");
    // eslint-disable-next-line obsidianmd/no-static-styles-assignment -- the page's root, for one move
    root.style.setProperty("scroll-behavior", "auto");
    target.scrollTo(to);
    if (saved) root.style.setProperty("scroll-behavior", saved);
    else root.style.removeProperty("scroll-behavior");
  }
}

/**
 * Whether an element of a page is fixed or sticky, and so where the window
 * is rather than where it is in the page.
 */
export function isPinned(element: Element, win: Window): boolean {
  const position = win.getComputedStyle(element).position;
  return position === "fixed" || position === "sticky";
}

/**
 * Where a page is scrolled to, by what it shows at the window's top: the
 * innermost element there, as its index among its parent's children at each
 * level down from the body, and how far the window's top is into the
 * element, as a share of its height. Another document of the same copy holds
 * the same elements, so the place is the same in it, also where it lays the
 * page out at another width.
 */
export interface ScrollPlace {
  readonly path: readonly number[];
  readonly into: number;
  /** How far the window is scrolled sideways, in pixels. */
  readonly left: number;
}

/**
 * Where `doc`'s window is scrolled to, or null at the page's top. Only the
 * window's scrolling counts: a region of the page that scrolls by itself is
 * not part of the place.
 */
export function scrollPlace(doc: Document): ScrollPlace | null {
  const win = doc.defaultView;
  const body = doc.body;
  if (!win || !body || (win.scrollY <= 0 && win.scrollX <= 0)) return null;
  const atTop = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    return box.top <= 0 && box.bottom > 0 && !isPinned(element, win);
  };
  const path: number[] = [];
  let element: Element = body;
  for (;;) {
    const index = [...element.children].findIndex(atTop);
    if (index === -1) break;
    path.push(index);
    element = element.children[index];
  }
  const box = element.getBoundingClientRect();
  return { path, into: box.height > 0 ? -box.top / box.height : 0, left: win.scrollX };
}

/**
 * How far `doc`'s window scrolls down to show `place` at its top, or null
 * without a body. Where the document shows the place's element in no box, as
 * when a `<details>` element or a part that a checkbox opens in the page's
 * styles is closed again, or lacks it, the page is shown from the top of the
 * deepest of the element's parents that it shows.
 */
export function placeTop(doc: Document, place: ScrollPlace): number | null {
  const win = doc.defaultView;
  const body = doc.body;
  if (!win || !body) return null;
  let element: Element = body;
  for (const index of place.path) {
    const child: Element | null = element.children.item(index);
    if (child === null || child.getClientRects().length === 0)
      return win.scrollY + element.getBoundingClientRect().top;
    element = child;
  }
  const box = element.getBoundingClientRect();
  return win.scrollY + box.top + place.into * box.height;
}

/** The reader's input that can scroll a page, or a side of the split view. */
const READER_INPUT = ["keydown", "pointerdown", "touchstart", "wheel"] as const;

/**
 * Scrolls a document to a place, as soon as its text is there. Until the page
 * has loaded, its images can still move its content, or leave it too short to
 * reach the place, so it is placed again when it loads, unless the reader has
 * acted first, in the page or on one of `others`, such as the split view's
 * source. The page's images, media, and fonts can come from any web address,
 * and `load` waits until each has arrived or failed, which for a host that
 * does not answer can take minutes: placing the page then would undo the
 * reader's scrolling. Scroll events cannot tell the reader's scrolling apart,
 * since Chromium's scroll anchoring also scrolls the page when content above
 * its top loads, so the reader's input counts instead. Nothing waits after
 * `signal`, which says that the frame no longer shows the document.
 */
export function showPlace(
  doc: Document,
  place: ScrollPlace,
  others: readonly EventTarget[],
  signal: AbortSignal,
): void {
  const win = doc.defaultView;
  if (!win) return;
  const show = (): void => {
    const top = placeTop(doc, place);
    if (top !== null) scrollInstantly(win, doc.documentElement, { top, left: place.left });
  };
  show();
  if (doc.readyState === "complete" || signal.aborted) return;
  // AbortSignal.any is newer than Obsidian 1.5.3's Chromium 114.
  const pending = new AbortController();
  const stop = (): void => pending.abort();
  signal.addEventListener("abort", stop, { signal: pending.signal });
  win.addEventListener(
    "load",
    () => {
      stop();
      show();
    },
    { signal: pending.signal },
  );
  for (const target of [doc, ...others]) {
    for (const type of READER_INPUT)
      target.addEventListener(type, stop, { capture: true, passive: true, signal: pending.signal });
  }
}
