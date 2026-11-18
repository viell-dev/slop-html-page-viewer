// Scrolling the page in the view's frame: at once, past the page's own smooth
// scrolling, and back to where the frame's previous document of the same copy
// was when its tab moved to another tab group or window (#126), unless the
// reader has scrolled since (#157). The source of the source view and of the
// split view goes back to its place after such a move too (#135, #157).

import type { ScrollFollower } from "./split";

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
 * Whether an element has no box of its own but shows its children, as the
 * wrapper that SvelteKit puts around a page's content does.
 */
function isContents(element: Element, win: Window): boolean {
  return win.getComputedStyle(element).display === "contents";
}

/**
 * Where `doc`'s window is scrolled to, or null at the page's top. Only the
 * window's scrolling counts: a region of the page that scrolls by itself is
 * not part of the place. An element with `display: contents` is on the way
 * down to the element at the top when one of its children is.
 */
export function scrollPlace(doc: Document): ScrollPlace | null {
  const win = doc.defaultView;
  const body = doc.body;
  if (!win || !body || (win.scrollY <= 0 && win.scrollX <= 0)) return null;
  const holdsTop = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    if (box.top <= 0 && box.bottom > 0) return !isPinned(element, win);
    return (
      box.width === 0 &&
      box.height === 0 &&
      isContents(element, win) &&
      [...element.children].some(holdsTop)
    );
  };
  const path: number[] = [];
  let element: Element = body;
  for (;;) {
    const index = [...element.children].findIndex(holdsTop);
    if (index === -1) break;
    path.push(index);
    element = element.children[index];
  }
  const box = element.getBoundingClientRect();
  return { path, into: box.height > 0 ? -box.top / box.height : 0, left: win.scrollX };
}

/** Values of `overflow` that clip an element's content to its padding box. */
const CLIPPING = new Set(["auto", "clip", "hidden", "scroll"]);

/**
 * How far `doc`'s window scrolls down to show `place` at its top, or null
 * without a body.
 *
 * Where the document no longer shows the way down to the place's element, the
 * page is shown from the top of the deepest element on that way that it still
 * shows. So a part that the page opens and the document has closed again
 * comes to the window's top: a `<details>` element with its summary; a part
 * that the page's styles close by its height, as with `max-height: 0` and
 * `overflow: hidden`, where its content would begin; and a part that they
 * hide with `display: none`, with the element around it. An element counts
 * as not shown when it has no box; when `checkVisibility()` says so, as for
 * the content of a closed `<details>` element, which Chromium keeps laid out
 * and so reports a box for; and when an element above it that clips its
 * overflow leaves none of it in view. The body's own overflow is not counted,
 * since it can be the window's. An element with `display: contents` has no
 * box but shows its children, so the way passes through it.
 */
export function placeTop(doc: Document, place: ScrollPlace): number | null {
  const win = doc.defaultView;
  const body = doc.body;
  if (!win || !body) return null;
  let element: Element = body;
  let shown: Element = body;
  // The band of the window, in its coordinates, that the elements above
  // `element` clip their content to.
  let clipTop = -Infinity;
  let clipBottom = Infinity;
  const fallback = (): number => win.scrollY + shown.getBoundingClientRect().top;
  for (const index of place.path) {
    const child: Element | null = element.children.item(index);
    if (child === null) return fallback();
    element = child;
    const style = win.getComputedStyle(child);
    if (style.display === "contents") continue;
    const box = child.getBoundingClientRect();
    if (
      child.getClientRects().length === 0 ||
      (child.checkVisibility ? !child.checkVisibility() : false) ||
      clipTop >= clipBottom ||
      box.top >= clipBottom ||
      box.bottom <= clipTop
    )
      return fallback();
    // An inline box has no client area of its own, so its overflow clips
    // nothing; the same holds for an inline `<svg>`.
    if (CLIPPING.has(style.overflowY) && style.display !== "inline") {
      const top = box.top + child.clientTop;
      clipTop = Math.max(clipTop, top);
      clipBottom = Math.min(clipBottom, top + child.clientHeight);
    }
    shown = child;
  }
  if (element !== shown) return fallback();
  const box = shown.getBoundingClientRect();
  const at = box.top + place.into * box.height;
  // The place can lie in the part of an element that an element above it
  // clips away, as in a paragraph that runs past a panel's height limit.
  if (at >= clipBottom) return fallback();
  return win.scrollY + at;
}

/** The reader's input that can scroll a page, or a side of the split view. */
const READER_INPUT = ["keydown", "pointerdown", "touchstart", "wheel"] as const;

/**
 * Scrolls a document to a place, as soon as its text is there. Until the page
 * has loaded, its images can still move its content, or leave it too short to
 * reach the place, so it is placed again when it loads, unless the reader has
 * acted first, in the page or on one of `others`, such as the split view's
 * source, or had already acted, as `acted` says. The page's images, media,
 * and fonts can come from any web address, and `load` waits until each has
 * arrived or failed, which for a host that does not answer can take minutes:
 * placing the page then would undo the reader's scrolling. Scroll events
 * cannot tell the reader's scrolling apart, since Chromium's scroll anchoring
 * also scrolls the page when content above its top loads, so the reader's
 * input counts instead. Nothing waits after `signal`, which says that the
 * frame no longer shows the document. `moved` is called each time that
 * placing the page scrolls it.
 */
export function showPlace(
  doc: Document,
  place: ScrollPlace,
  others: readonly EventTarget[],
  signal: AbortSignal,
  { acted = false, moved }: { readonly acted?: boolean; readonly moved?: () => void } = {},
): void {
  const win = doc.defaultView;
  if (!win) return;
  const show = (): void => {
    const top = placeTop(doc, place);
    if (top === null) return;
    const { scrollX, scrollY } = win;
    scrollInstantly(win, doc.documentElement, { top, left: place.left });
    if (win.scrollX !== scrollX || win.scrollY !== scrollY) moved?.();
  };
  show();
  if (acted || doc.readyState === "complete" || signal.aborted) return;
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

/** What the reader did while `watchReader` watched. */
export interface ReaderActivity {
  /** Whether they pressed a key or a pointer button, touched the screen, or turned the wheel. */
  readonly acted: boolean;
  /** Whether the element watched for scrolling reported a scroll after that. */
  readonly scrolled: boolean;
}

/** A watch of the reader, from `watchReader`. */
export interface ReaderWatch {
  /** Ends the watch, and says what the reader did. */
  stop(): ReaderActivity;
}

/**
 * Watches the reader's input in `view`, and the scrolling of `scrolling`
 * after it, until `stop`, which says what the reader did: as while the frame
 * has dropped a page's document and the view does not show the next one yet
 * (#157). A scroll counts only after the reader's input, as Obsidian 1.15.1
 * scrolls the elements of a tab that it moves back itself (#135). Input
 * counts from the next task on, which leaves out an input that is still being
 * dispatched, as a hotkey pressed in the view that moved the tab.
 */
export function watchReader(view: HTMLElement, scrolling: HTMLElement | null): ReaderWatch {
  const watching = new AbortController();
  const activity = { acted: false, scrolled: false };
  let counting = false;
  view.ownerDocument.defaultView?.setTimeout(() => {
    counting = true;
  }, 0);
  const act = (): void => {
    if (counting) activity.acted = true;
  };
  for (const type of READER_INPUT)
    view.addEventListener(type, act, { capture: true, passive: true, signal: watching.signal });
  scrolling?.addEventListener(
    "scroll",
    () => {
      if (activity.acted) activity.scrolled = true;
    },
    { passive: true, signal: watching.signal },
  );
  return {
    stop: () => {
      watching.abort();
      return { ...activity };
    },
  };
}

/**
 * Shows a frame's document, which has its text, where the frame's previous
 * document of the same copy was, `place`, as after its tab moved (#126), and
 * keeps the split view's sides in step there with `follower`, if the view
 * shows the split view and can follow the page. `reader` says what the
 * reader did while the frame showed no page (#157), and is null when it
 * showed one, as for its first document.
 *
 * - If they scrolled the source, the page follows it, and is not placed.
 * - Otherwise the page is placed, and leads. A scroll of the source that the
 *   source reports later, in the frame of the placement or after it, leads
 *   instead, unless the reader has not acted: then the source's scrolling so
 *   far was not theirs, but Obsidian's, which scrolls a moved tab's elements
 *   back (#135), and it is passed over.
 * - After their input, the page is not placed again when it loads.
 */
export function placeNextDocument(
  doc: Document,
  place: ScrollPlace | null,
  reader: ReaderActivity | null,
  follower: Pick<ScrollFollower, "passOver" | "placed" | "scrolled"> | null,
  others: readonly EventTarget[],
  signal: AbortSignal,
): void {
  if (follower && reader?.scrolled) {
    follower.scrolled("source");
    return;
  }
  if (!place) return;
  const acted = reader?.acted ?? false;
  if (!acted) follower?.passOver("source");
  showPlace(doc, place, others, signal, { acted, moved: () => follower?.placed("page") });
}

/** An element's scroll position, kept for when the element loses it. */
export interface KeptScrolling {
  /**
   * Scrolls the element back to where it was last scrolled to, if it has
   * lost that place, as after Obsidian took it out of the page and inserted
   * it again.
   */
  restore(): void;
}

/**
 * Keeps where an element of the view is scrolled to, for when Obsidian takes
 * the tab's elements out of the page and inserts them again, as when the tab
 * moves to another tab group or window (#135). Chromium then shows the
 * element from its start, without a scroll event. Obsidian 1.15.1 scrolls it
 * back itself, and 1.5.3 does not. An element that has lost its place shows
 * its start while its last scroll event left it elsewhere. One that is not
 * laid out, as in a hidden tab or a window that has yet to lay it out, has
 * nothing to scroll, and is left alone until a later `restore`.
 *
 * The reader's scrolling to the start looks the same until Chromium reports
 * it, in the next animation frame, while a layout change or a resize can
 * come first (#157). So after the reader's input in the element, its start
 * is not taken for a lost place until that frame has passed, or the element
 * has reported a scroll. A window without animation frames renders nothing,
 * and its input does not count.
 */
export function keepScrolling(element: HTMLElement): KeptScrolling {
  let top = element.scrollTop;
  let left = element.scrollLeft;
  /** Whether a scroll of the reader's can still be unreported. */
  let unreported = false;
  element.addEventListener(
    "scroll",
    () => {
      top = element.scrollTop;
      left = element.scrollLeft;
      unreported = false;
    },
    { passive: true },
  );
  const acted = (): void => {
    const win = element.ownerDocument.defaultView;
    if (!win?.requestAnimationFrame) return;
    unreported = true;
    // Chromium reports a frame's scrolling before its animation frame callbacks.
    win.requestAnimationFrame(() => {
      unreported = false;
    });
  };
  for (const type of READER_INPUT)
    element.addEventListener(type, acted, { capture: true, passive: true });
  return {
    restore: () => {
      if (unreported || !element.isConnected || element.clientHeight === 0) return;
      if (element.scrollTop !== 0 || element.scrollLeft !== 0 || (top === 0 && left === 0)) return;
      scrollInstantly(element, element, { top, left });
    },
  };
}
