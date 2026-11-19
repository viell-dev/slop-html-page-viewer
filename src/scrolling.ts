// Scrolling the page in the view's frame: at once, past the page's own smooth
// scrolling, and back to where the frame's previous document of the same copy
// was when its tab moved to another tab group or window (#126), unless the
// reader has scrolled since (#157). The source of the source view and of the
// split view goes back to its place after such a move too (#135, #157), and
// the page after Obsidian hid its tab and showed it again (#178).

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
 * Keys that change what other keys do, and never scroll by themselves: the
 * key that they change sends a keydown of its own, as Home does with Control
 * held. A hotkey's other key, which Obsidian takes, does not reach the view.
 */
const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/**
 * Whether an event of READER_INPUT can scroll: every one but the keydown of a
 * modifier key, as a hotkey or a macro sends right before the key that it
 * changes (#167). The event can come from another window's realm, as after
 * the tab moved to a new window, so its type says that it is a key.
 */
function canScroll(event: Event): boolean {
  return event.type !== "keydown" || !MODIFIER_KEYS.has((event as KeyboardEvent).key);
}

/**
 * Calls `listener` at the reader's input on `target` that can scroll, before
 * the listeners of the elements inside it.
 */
function onReaderInput(target: EventTarget, listener: () => void, signal?: AbortSignal): void {
  const input = (event: Event): void => {
    if (canScroll(event)) listener();
  };
  for (const type of READER_INPUT)
    target.addEventListener(type, input, { capture: true, passive: true, signal });
}

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
  for (const target of [doc, ...others]) onReaderInput(target, stop, pending.signal);
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
  onReaderInput(
    view,
    () => {
      if (counting) activity.acted = true;
    },
    watching.signal,
  );
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

/** A scroll position kept for when what scrolls loses it: an element of the view, or a page. */
export interface KeptScrolling {
  /**
   * Scrolls back to where it was last scrolled to, if it has lost that place,
   * as after Obsidian took it out of the page and inserted it again.
   */
  restore(): void;
  /**
   * Keeps where it is now, after the view scrolled it itself, as the find bar
   * does to show a match (#167). Chromium can report that scroll only in its
   * next frame, and until then a scroll to the start looks like a lost place.
   * What is not laid out keeps its place.
   */
  placed(): void;
}

/** What `keepPlace` keeps the scroll position of. */
interface Scrolled {
  /**
   * What gets the scroll event of its scrolling, and the reader's input in
   * it: an element, or the window of a page, whose document's scroll event
   * reaches it, as the input of the document does.
   */
  readonly events: EventTarget;
  /** The window that renders it. */
  window(): Window | null;
  /** Where it is scrolled to. */
  position(): { readonly top: number; readonly left: number };
  /** Whether it is laid out, and so shows where it is scrolled to. */
  laidOut(): boolean;
  /** Scrolls it at once. */
  scrollTo(to: { readonly top: number; readonly left: number }): void;
}

/**
 * Keeps where `scrolled` is scrolled to, until `signal`. It has lost its
 * place when it shows its start while its last scroll event left it
 * elsewhere. What is not laid out has nothing to scroll, and is left alone
 * until a later `restore`; a scroll that it reports then is Chromium's, as
 * when it scrolls a hidden frame's page to its start (#178), and is not kept.
 *
 * The reader's scrolling to the start looks the same until Chromium reports
 * it, in the next animation frame, while a layout change or a resize can
 * come first (#157). So after the reader's input in it, its start is not
 * taken for a lost place until that frame has passed, or it has reported a
 * scroll. A modifier key is not such input: it would keep a place lost to a
 * move that a hotkey makes in the same frame (#167). A window without
 * animation frames renders nothing, and its input does not count.
 */
function keepPlace(scrolled: Scrolled, signal?: AbortSignal): KeptScrolling {
  let kept = scrolled.position();
  /** Whether a scroll of the reader's can still be unreported. */
  let unreported = false;
  scrolled.events.addEventListener(
    "scroll",
    () => {
      if (!scrolled.laidOut()) return;
      kept = scrolled.position();
      unreported = false;
    },
    { passive: true, signal },
  );
  onReaderInput(
    scrolled.events,
    () => {
      const win = scrolled.window();
      if (!win?.requestAnimationFrame) return;
      unreported = true;
      // Chromium reports a frame's scrolling before its animation frame callbacks.
      win.requestAnimationFrame(() => {
        unreported = false;
      });
    },
    signal,
  );
  return {
    restore: () => {
      if (unreported || !scrolled.laidOut()) return;
      const { top, left } = scrolled.position();
      if (top !== 0 || left !== 0 || (kept.top === 0 && kept.left === 0)) return;
      scrolled.scrollTo(kept);
    },
    placed: () => {
      if (scrolled.laidOut()) kept = scrolled.position();
    },
  };
}

/**
 * Keeps where an element of the view is scrolled to, for when Obsidian takes
 * the tab's elements out of the page and inserts them again, as when the tab
 * moves to another tab group or window (#135). Chromium then shows the
 * element from its start, without a scroll event. Obsidian 1.15.1 scrolls it
 * back itself, and 1.5.3 does not. An element that is not laid out, as in a
 * hidden tab or a window that has yet to lay it out, is left alone. Chromium
 * keeps the element's place itself when Obsidian hides the tab and shows it
 * again (#178).
 *
 * Where the find bar scrolls the element, `placed` tells it so. The split
 * view's follower, and its putting the sides in step again in a new window
 * (#165), do not: their lowest target is the first line, below the source's
 * top padding, so they never leave the element at its start.
 */
export function keepScrolling(element: HTMLElement): KeptScrolling {
  return keepPlace({
    events: element,
    window: () => element.ownerDocument.defaultView,
    position: () => ({ top: element.scrollTop, left: element.scrollLeft }),
    laidOut: () => element.isConnected && element.clientHeight !== 0,
    scrollTo: (to) => scrollInstantly(element, element, to),
  });
}

/**
 * Whether `frame` shows `doc` and is laid out, and so shows where `doc` is
 * scrolled to. A frame that is not in the page has no size either.
 */
export function frameShows(frame: HTMLIFrameElement, doc: Document): boolean {
  return frame.contentDocument === doc && frame.clientHeight !== 0;
}

/**
 * Keeps where a frame's document `doc` is scrolled to, as a whole, for when
 * Obsidian hides the frame's tab and shows it again, as when the reader shows
 * another tab of its tab group and then this one (#178). Obsidian hides a tab
 * with `display: none`. Chromium then scrolls the document to its start, and
 * reports that scroll while the frame is hidden, and it leaves the document
 * there when the frame shows again. The elements that scroll inside the
 * document, and the view's own, such as the source, it puts back itself.
 *
 * The document goes back to its place, as `keepPlace` keeps it, as soon as
 * the frame's own window lays the frame out again after it was hidden, before
 * that window paints it: when its ResizeObserver reports that the frame has a
 * size again. `moved` is called when that scrolls the document. Nothing is
 * kept or put back after `signal`, which says that the frame no longer shows
 * the document. Returns the kept place, for the find bar's scrolling of the
 * document, or null where nothing can put it back: in a window without
 * ResizeObserver, as jsdom is.
 */
export function keepPageScrolling(
  frame: HTMLIFrameElement,
  doc: Document,
  signal: AbortSignal,
  moved?: () => void,
): KeptScrolling | null {
  const win = doc.defaultView;
  const owner = frame.ownerDocument.defaultView;
  if (!win || !owner?.ResizeObserver || signal.aborted) return null;
  const kept = keepPlace(
    {
      events: win,
      window: () => win,
      position: () => ({ top: win.scrollY, left: win.scrollX }),
      laidOut: () => frameShows(frame, doc),
      scrollTo: (to) => scrollInstantly(win, doc.documentElement, to),
    },
    signal,
  );
  let shown = frameShows(frame, doc);
  // Only a frame that shows again: one resized while it shows, as in a new
  // window, stays where it is, which can be a place that the reader, the
  // find bar, or the split view's follower has just given it, and that
  // Chromium has yet to report.
  const observer = new owner.ResizeObserver(() => {
    const hidden = !shown;
    shown = frameShows(frame, doc);
    if (!hidden || !shown) return;
    const { scrollX, scrollY } = win;
    kept.restore();
    if (win.scrollX !== scrollX || win.scrollY !== scrollY) moved?.();
  });
  observer.observe(frame);
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  return kept;
}
