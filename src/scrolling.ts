// Scrolling the page in the view's frame: at once, past the page's own smooth
// scrolling, and back to where the frame's previous document of the same copy
// was when its tab moved to another tab group or window (#126), also while
// hidden (#186), unless the reader has scrolled since (#157), with the split
// view's side that led last leading again (#195). The source of the source
// view and of the split view goes back to its place after such a move too
// (#135, #157), and the page and the source after Obsidian hid the tab and
// showed it again (#178), to what they showed, also at another width (#182,
// #189).

import type { ScrollFollower, SideName } from "./split";

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
 * Shows a document where it is to be, as `show` puts it, as soon as its text
 * is there. Until the page has loaded, its images can still move its content,
 * or leave it too short to reach its place, so it is shown there again when it
 * loads, unless the reader has acted first, in the page or on one of
 * `others`, such as the split view's source, or had already acted, as `acted`
 * says. The page's images, media, and fonts can come from any web address,
 * and `load` waits until each has arrived or failed, which for a host that
 * does not answer can take minutes: showing the page again then would undo
 * the reader's scrolling. Scroll events cannot tell the reader's scrolling
 * apart, since Chromium's scroll anchoring also scrolls the page when content
 * above its top loads, so the reader's input counts instead. Nothing waits
 * after `signal`, which says that the frame no longer shows the document.
 * `show` gets a signal that aborts once nothing shows the page again: at its
 * load, before `show` runs then, at the reader's input, or at `signal`.
 */
function showUntilLoaded(
  doc: Document,
  others: readonly EventTarget[],
  signal: AbortSignal,
  acted: boolean,
  show: (pending: AbortSignal) => void,
): void {
  const win = doc.defaultView;
  if (!win) return;
  // AbortSignal.any is newer than Obsidian 1.5.3's Chromium 114.
  const pending = new AbortController();
  const stop = (): void => pending.abort();
  if (acted || doc.readyState === "complete" || signal.aborted) stop();
  show(pending.signal);
  if (pending.signal.aborted) return;
  signal.addEventListener("abort", stop, { signal: pending.signal });
  win.addEventListener(
    "load",
    () => {
      stop();
      show(pending.signal);
    },
    { signal: pending.signal },
  );
  for (const target of [doc, ...others]) onReaderInput(target, stop, pending.signal);
}

/**
 * Scrolls a document to a place, as soon as its text is there, and again when
 * it loads, as `showUntilLoaded` says. `moved` is called each time that
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
  showUntilLoaded(doc, others, signal, acted, () => {
    const top = placeTop(doc, place);
    if (top === null) return;
    const { scrollX, scrollY } = win;
    scrollInstantly(win, doc.documentElement, { top, left: place.left });
    if (win.scrollX !== scrollX || win.scrollY !== scrollY) moved?.();
  });
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

/** What the view keeps of a frame's previous document of the same copy for the next one. */
export interface PreviousDocument {
  /** Where the previous document was scrolled to when the frame dropped it (#126). */
  readonly place: ScrollPlace | null;
  /** The side of the split view that led last then, or null where none had led (#195). */
  readonly led: SideName | null;
}

/** The split view's following of its sides, for the frame's next document. */
export interface NextDocumentFollowing {
  readonly follower: Pick<ScrollFollower, "passOver" | "placed" | "scrolled">;
  /**
   * Measures the page again, as its images can have moved its content, and
   * has the source lead from where it is: the page follows it, and its own
   * scrolling, as Chromium's scroll anchoring makes it while its images load,
   * leads nothing until `until` aborts.
   */
  sourceLeads(until: AbortSignal): void;
}

/**
 * Shows a frame's document, which has its text, as the frame's previous
 * document of the same copy was, `previous`, as after its tab moved (#126),
 * and keeps the split view's sides in step there with `split`, if the view
 * shows the split view and can follow the page. `reader` says what the
 * reader did while the frame showed no page (#157), also before its first one
 * in the split view (#215), and is null when nothing watched them.
 *
 * - If they scrolled the source, the page follows it, and is not placed.
 * - Otherwise, where the source led last, it leads again from its line, where
 *   its kept place has put it back, and the page follows it (#195).
 * - Otherwise the page is placed where the previous document was, and leads.
 *   A scroll of the source that the source reports later, in the frame of the
 *   placement or after it, leads instead, unless the reader has not acted:
 *   then the source's scrolling so far was not theirs, but Obsidian's, which
 *   scrolls a moved tab's elements back (#135), and it is passed over.
 * - Either side leads again when the page loads, unless the reader acted.
 *
 * Returns the place that the page is to show, or undefined where there is
 * none, or the page follows the source instead: a frame that has no size yet
 * shows it only once it has one (#186).
 */
export function placeNextDocument(
  doc: Document,
  previous: PreviousDocument,
  reader: ReaderActivity | null,
  split: NextDocumentFollowing | null,
  others: readonly EventTarget[],
  signal: AbortSignal,
): ScrollPlace | undefined {
  if (split && reader?.scrolled) {
    split.follower.scrolled("source");
    return undefined;
  }
  const acted = reader?.acted ?? false;
  if (split && previous.led === "source") {
    showUntilLoaded(doc, others, signal, acted, (pending) => split.sourceLeads(pending));
    return undefined;
  }
  const { place } = previous;
  if (!place) return undefined;
  if (!acted) split?.follower.passOver("source");
  showPlace(doc, place, others, signal, { acted, moved: () => split?.follower.placed("page") });
  return place;
}

/** A scroll position kept for when what scrolls loses it: an element of the view, or a page. */
export interface KeptScrolling {
  /**
   * Scrolls back to where it was last scrolled to, if it has lost that place,
   * as after Obsidian took it out of the page and inserted it again. Where it
   * keeps what it showed there, it scrolls to show that, as laid out now
   * (#189).
   */
  restore(): void;
  /**
   * Keeps where it is now, after the view scrolled it itself, as the find bar
   * does to show a match (#167). Chromium can report that scroll only in its
   * next frame, and until then a scroll to the start looks like a lost place.
   * What is not laid out keeps its place.
   */
  placed(): void;
  /**
   * Keeps the place as it is until `back` or `release`, whatever scroll is
   * reported meanwhile, as while Obsidian hides the tab and shows it again
   * (#178), or moves it (#189), apart from the reader's own: a scroll that it
   * reports in the frame of the reader's input in it ends the hold, and is
   * kept. One that Chromium reports a frame later is not.
   */
  hold(): void;
  /**
   * Ends `hold`, and scrolls back to the place held if it shows another place
   * now, unless the reader's input in it can still be unreported. Where it
   * keeps what it showed there, it scrolls to show that, as laid out now
   * (#182).
   */
  back(): void;
  /** Ends `hold`, and keeps where it is now, as where the reader scrolled it. */
  release(): void;
  /**
   * Shows what it showed, as laid out now, where its content was laid out
   * anew with no scroll that says so, as when a new window's styles arrive
   * after the tab moved there (#165, #189). Where the reader has scrolled it
   * since, that is where they scrolled it. Nothing happens while it is held.
   */
  again(): void;
}

/** How far something is scrolled, in pixels. */
export interface Position {
  readonly top: number;
  readonly left: number;
}

/**
 * What a scroll position shows, as a place in its content, which holds where
 * the content is laid out at another width (#182): the element at a page's
 * top, or the line at a source's. How far it is scrolled sideways stays in
 * pixels.
 */
export interface Placing<P> {
  /** What it shows now, where it is laid out, or undefined if it cannot tell. */
  measure(): P | undefined;
  /** How far down it scrolls to show `place`, as it is laid out now, or null if it cannot tell. */
  topFor(place: P): number | null;
  /**
   * Whether measuring it costs so little that it is measured at each report
   * of a scroll, rather than once its scrolling has settled.
   */
  readonly atOnce?: boolean;
}

/**
 * How long a scroller reports no scroll before what it shows is measured, in
 * milliseconds: about six frames. A scroll that comes in steps, as a mouse
 * wheel without smooth scrolling sends, settles once at its end, and not
 * after each step (#182).
 */
const SETTLING = 100;

/** What `keepPlace` keeps the scroll position of. */
interface Scroller {
  /**
   * What gets the scroll event of its scrolling, and the reader's input in
   * it: an element, or the window of a page, whose document's scroll event
   * reaches it, as the input of the document does.
   */
  readonly events: EventTarget;
  /** The window that renders it. */
  window(): Window | null;
  /** Where it is scrolled to. */
  position(): Position;
  /** How far down it can be scrolled. */
  furthest(): number;
  /**
   * Whether Obsidian can put it back in pixels, as it does the elements of a
   * tab that it moves, and never a frame's page (#189).
   */
  readonly obsidianPutsBack: boolean;
  /**
   * Whether only Obsidian, the reader, and what tells `placed` scroll it, as a
   * source beside no page that the view can reach, which follows none.
   */
  readonly alone: boolean;
  /** Whether it is laid out, and so shows where it is scrolled to. */
  laidOut(): boolean;
  /** Scrolls it at once. */
  scrollTo(to: Position): void;
}

/** A kept scroll position, with what keepPlace keeps for its kinds of scroller. */
interface KeptPlace<P> extends KeptScrolling {
  /** What it measured last that it shows, or undefined before it has. */
  place(): P | undefined;
  /**
   * Its content's layout changed while it is laid out, with no scroll that
   * says so, as where a page with no scroll anchoring narrows: what it
   * measured is out of date until it is measured again.
   */
  relaidOut(): void;
}

/**
 * Keeps where `scroller` is scrolled to, until `signal`. It has lost its
 * place when it shows its start while its last scroll event left it
 * elsewhere. What is not laid out has nothing to scroll, and is left alone
 * until a later `restore`; a scroll that it reports then is Chromium's, as
 * when it scrolls a hidden frame's page to its start (#178), and is not kept.
 * Neither is a scroll that it reports while held, unless it comes after the
 * reader's input in it.
 *
 * The reader's scrolling to the start looks the same until Chromium reports
 * it, in the next animation frame, while a layout change or a resize can
 * come first (#157). So after the reader's input in it, its start is not
 * taken for a lost place until that frame has passed, or it has reported a
 * scroll. A modifier key is not such input: it would keep a place lost to a
 * move that a hotkey makes in the same frame (#167). A window without
 * animation frames renders nothing, and its input does not count.
 *
 * With `placing`, it also keeps what it shows, for `back` and `restore`
 * (#182, #189): `shown` to start with, as the place that the view shows it
 * at, and then what it measures once it has reported no scroll for SETTLING
 * milliseconds of its window's animation frames, also after `placed`,
 * `release`, and `relaidOut`, or at once where `placing` says so. Where it
 * goes back to what it showed, that is up to date where it put it, and the
 * change of layout that `back`'s showing reports in that animation frame
 * does not make it out of date. Measuring a page's place reads the boxes of
 * its elements, which on a long page takes a share of a frame that would show
 * in every frame of a scroll, or at each step of the find bar. Nothing is
 * measured while it is not laid out, nor elsewhere than it was last reported:
 * a settling that a hide interrupted can end in the frame that shows the tab
 * again, where Chromium shows the page from its start until `back` (#201).
 *
 * What it measured is out of date where it was measured elsewhere than it
 * was last reported, as when the reader scrolled it and Obsidian hid the tab
 * before the scrolling settled, and after `relaidOut` until it is measured
 * again: it then goes back to where it was last reported, and `place` still
 * says what it measured last.
 *
 * A scroll that an element of the view reports as far down and as far
 * sideways as it was last reported, or at its end short of that, says that it
 * lost its place and was put back in pixels within one frame: Obsidian does
 * that with the elements of a tab that it moves, also where they wrap
 * otherwise in the tab's new pane (#135, #189). It then shows what it showed,
 * as laid out now, if it has that up to date.
 */
function keepPlace<P>(
  scroller: Scroller,
  {
    placing = null,
    shown,
    signal,
  }: {
    readonly placing?: Placing<P> | null;
    readonly shown?: { readonly place: P };
    readonly signal?: AbortSignal;
  } = {},
): KeptPlace<P> {
  let kept = scroller.position();
  /** Whether a scroll of the reader's can still be unreported. */
  let unreported = false;
  let held = false;
  let visited = scroller.window();
  /**
   * Whether it is alone, and has yet to show its place in the window that it
   * moved to: the reader has not used it there, and it has reported no scroll
   * that left it at its place.
   */
  let arriving = false;
  /** Notices that it has moved to another window. */
  const visit = (): void => {
    const now = scroller.window();
    if (now === null || now === visited) return;
    visited = now;
    arriving = scroller.alone;
  };
  /**
   * What it shows `at` pixels down, by `placing`: up to date while that is as
   * far down as `kept`, unless `outdated`. Scrolling sideways changes nothing
   * that it shows from its top.
   */
  let content: { readonly place: P; readonly at: number } | null =
    placing && shown ? { place: shown.place, at: kept.top } : null;
  let outdated = false;
  /** Whether `back` has shown it again in this animation frame. */
  let shownAgain = false;
  const measure = (): void => {
    if (!placing || !scroller.laidOut()) return;
    // Elsewhere than it was last reported, it has lost its place, as a page
    // has in the frame that shows its tab again, until `back`.
    const { top } = scroller.position();
    if (top !== kept.top) return;
    const place = placing.measure();
    if (place === undefined) return;
    content = { place, at: top };
    outdated = false;
  };
  /** The window whose animation frames say whether its scrolling has settled. */
  let settling: Window | null = null;
  /** Whether it reported a scroll since the last of those frames. */
  let moving = false;
  /** The time of the first of those frames since its last report. */
  let quietSince = 0;
  const settle = (win: Window | null): void => {
    settling = win;
    if (!win?.requestAnimationFrame) {
      settling = null;
      moving = false;
      measure();
      return;
    }
    // Chromium reports a frame's scrolling before its animation frame
    // callbacks, so the first of these runs in the frame of the report. A
    // source that moves to another window waits in that window's frames.
    win.requestAnimationFrame((time) => {
      if (settling !== win) return;
      if (moving) {
        moving = false;
        quietSince = time;
        settle(win);
      } else if (time - quietSince < SETTLING) {
        settle(win);
      } else {
        settling = null;
        measure();
      }
    });
  };
  /**
   * It is at `kept` now: what it shows there is measured once its scrolling
   * settles, or at once where `placing` says so.
   */
  const measureWhenSettled = (): void => {
    if (!placing) return;
    if (placing.atOnce) {
      measure();
      return;
    }
    moving = true;
    const win = scroller.window();
    if (settling !== win) settle(win);
  };
  /**
   * Where it goes back to: where it shows what it showed, while that is up
   * to date, and where it was otherwise. Within a pixel of where it was, as
   * where nothing has changed, it goes back to that exactly, so that rounding
   * cannot move it at each switch.
   */
  const target = (): Position => {
    if (!placing || !content || outdated || content.at !== kept.top) return kept;
    const top = placing.topFor(content.place);
    if (top === null || Math.abs(top - kept.top) < 1) return kept;
    return { top: Math.round(top), left: kept.left };
  };
  /** Scrolls to `to`, where it shows what it showed, which is up to date there. */
  const showAt = (to: Position): void => {
    scroller.scrollTo(to);
    kept = scroller.position();
    if (content) content = { place: content.place, at: kept.top };
  };
  /** Goes back to `target`, if it is elsewhere. */
  const goBack = (): void => {
    const to = target();
    const { top, left } = scroller.position();
    if (top === to.top && left === to.left) return;
    if (to === kept) scroller.scrollTo(to);
    else showAt(to);
  };
  scroller.events.addEventListener(
    "scroll",
    () => {
      if (!scroller.laidOut()) return;
      // A scroll that it reports in the frame of the reader's input is theirs.
      visit();
      if (held && !unreported) return;
      held = false;
      unreported = false;
      const now = scroller.position();
      // Until it is at its place in a window that it moved to, its reports are
      // of Obsidian's or the view's putting it back, or of where that left it
      // once the window laid it out anew before the report, with another
      // height or by Chromium's scroll anchoring (#218).
      if (arriving) {
        goBack();
        const { top, left } = scroller.position();
        arriving = top !== now.top || left !== now.left;
        return;
      }
      const putBack =
        scroller.obsidianPutsBack &&
        now.left === kept.left &&
        (now.top === kept.top || (now.top < kept.top && now.top >= scroller.furthest() - 1));
      const to = putBack ? target() : kept;
      if (to !== kept) {
        showAt(to);
        return;
      }
      kept = now;
      measureWhenSettled();
    },
    { passive: true, signal },
  );
  onReaderInput(
    scroller.events,
    () => {
      visit();
      arriving = false;
      const win = scroller.window();
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
      visit();
      if (unreported || !scroller.laidOut()) return;
      const { top, left } = scroller.position();
      if (top !== 0 || left !== 0 || (kept.top === 0 && kept.left === 0)) return;
      goBack();
    },
    placed: () => {
      visit();
      arriving = false;
      if (!scroller.laidOut()) return;
      kept = scroller.position();
      measureWhenSettled();
    },
    hold: () => {
      held = true;
    },
    back: () => {
      held = false;
      if (unreported || !scroller.laidOut()) return;
      // It is shown by its layout now, which the change of layout that showing
      // it reports, in this animation frame, is no change of.
      const win = scroller.window();
      if (win?.requestAnimationFrame) {
        shownAgain = true;
        win.requestAnimationFrame(() => {
          shownAgain = false;
        });
      }
      goBack();
    },
    release: () => {
      held = false;
      if (!scroller.laidOut()) return;
      kept = scroller.position();
      measureWhenSettled();
    },
    again: () => {
      if (held || unreported || !scroller.laidOut()) return;
      goBack();
    },
    place: () => content?.place,
    relaidOut: () => {
      if (!placing || shownAgain || !scroller.laidOut()) return;
      outdated = true;
      measureWhenSettled();
    },
  };
}

/**
 * Keeps where an element of the view is scrolled to, for when Obsidian takes
 * the tab's elements out of the page and inserts them again, as when the tab
 * moves to another tab group or window (#135). Chromium then shows the
 * element from its start, without a scroll event. Obsidian 1.15.1 scrolls it
 * back itself, as far down as it was, and 1.5.3 does so in some moves, as
 * where the tab was hidden once before. An element that is not laid out, as
 * in a hidden tab or a window that has yet to lay it out, is left alone.
 *
 * Where the find bar scrolls the element, `placed` tells it so. The split
 * view's follower, and its putting the sides in step again in a new window
 * (#165), do not: their lowest target is the first line, below the source's
 * top padding, so they never leave the element at its start.
 *
 * With `placing`, it goes back to what the element showed, as the source does
 * with its lines (#182, #189): when the tab shows again, after a move, and
 * where Obsidian has put the element back in pixels. One that is `alone` also
 * does at each report in another window, until one that finds it there or the
 * reader's input in it.
 */
export function keepScrolling<P>(
  element: HTMLElement,
  placing?: Placing<P>,
  { alone = false }: { readonly alone?: boolean } = {},
): KeptScrolling {
  return keepPlace(
    {
      events: element,
      window: () => element.ownerDocument.defaultView,
      position: () => ({ top: element.scrollTop, left: element.scrollLeft }),
      furthest: () => element.scrollHeight - element.clientHeight,
      obsidianPutsBack: true,
      alone,
      laidOut: () => element.isConnected && element.clientHeight !== 0,
      scrollTo: (to) => scrollInstantly(element, element, to),
    },
    { placing },
  );
}

/**
 * Whether `frame` shows `doc` and is laid out, and so shows where `doc` is
 * scrolled to. A frame that is not in the page has no size either.
 */
export function frameShows(frame: HTMLIFrameElement, doc: Document): boolean {
  return frame.contentDocument === doc && frame.clientHeight !== 0;
}

/** Where a page is scrolled to, from `keepPageScrolling`. */
export interface KeptPageScrolling extends KeptScrolling {
  /**
   * The element at the page's top when it last measured it, or the place
   * that the view showed it at, null at the page's top, or undefined before
   * either: for the frame's next document when the frame drops this one
   * while its tab is hidden, and the page has no layout to tell (#186).
   */
  place(): ScrollPlace | null | undefined;
}

/**
 * Keeps where a frame's document `doc` is scrolled to, as a whole, until
 * `signal`, which says that the frame no longer shows the document: for
 * `back` when Obsidian shows the frame's tab again after hiding it (#178),
 * and `placed` where the find bar scrolls the document. The scroll to its
 * start that Chromium reports while the frame is hidden comes while the
 * frame is not laid out, so the place needs no `hold`.
 *
 * It also keeps the element at the page's top, by `scrollPlace`, so that
 * `back` shows that element, also where the page is laid out at another
 * width when the frame shows again (#182). It starts from `shown`, the place
 * that the view shows the page at, if any: a frame that drops its document
 * while its tab stays hidden, as when Obsidian lays the tab group out anew,
 * has the next document's text with no size, so the view can show that
 * place only once the frame shows (#186).
 *
 * A layout change of the page while it shows, which can come with no scroll,
 * as with Obsidian's Readable line length turned off, or a page without
 * scroll anchoring narrowed, makes what it measured out of date: the page's
 * own window's ResizeObserver reports the sizes of its root and its body.
 * When the frame shows again, the frame's window's observer reports first,
 * and calls `back`; the page's window reports after it, in the same frame,
 * the change that showing the frame makes, which `back` has shown the page
 * by already and which is passed over. A window without ResizeObserver, as
 * jsdom is, tells nothing.
 */
export function keepPageScrolling(
  frame: HTMLIFrameElement,
  doc: Document,
  signal: AbortSignal,
  shown?: ScrollPlace,
): KeptPageScrolling | null {
  const win = doc.defaultView;
  if (!win) return null;
  const kept = keepPlace<ScrollPlace | null>(
    {
      events: win,
      window: () => win,
      position: () => ({ top: win.scrollY, left: win.scrollX }),
      furthest: () => doc.documentElement.scrollHeight - doc.documentElement.clientHeight,
      obsidianPutsBack: false,
      alone: false,
      laidOut: () => frameShows(frame, doc),
      scrollTo: (to) => scrollInstantly(win, doc.documentElement, to),
    },
    {
      placing: {
        measure: () => scrollPlace(doc),
        topFor: (place) => (place === null ? 0 : placeTop(doc, place)),
      },
      shown: shown === undefined ? undefined : { place: shown },
      signal,
    },
  );
  if (win.ResizeObserver && !signal.aborted) {
    const observer = new win.ResizeObserver(() => kept.relaidOut());
    observer.observe(doc.documentElement);
    if (doc.body) observer.observe(doc.body);
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  }
  return kept;
}

/** What the view does when Obsidian hides a frame's tab and shows it again (#178). */
export interface Hiding {
  /** The frame has no size, as in a tab that Obsidian hides with `display: none`. */
  hid(): void;
  /** The frame has a size again, before its window paints it. */
  shown(): void;
}

/**
 * Tells `hiding` when the frame's own window lays out a frame that shows
 * `doc` with no size and when with a size again, until `signal`: when its
 * ResizeObserver reports it, which a window does after its layout and before
 * it paints. A frame that has no size when watched counts as hidden.
 *
 * Obsidian hides a tab with `display: none`, as when the reader shows another
 * tab of its tab group, or collapses the sidebar that the tab is in. Chromium
 * then scrolls the frame's document to its start, reports that scroll while
 * the frame is hidden, and leaves the document there when the frame shows
 * again. The elements that scroll inside the document, and those of the
 * view, such as the source, it lays out again where they were scrolled to,
 * or near it: a source whose lines wrap, beside the page in the split view,
 * can come back tens of pixels or a few lines away. It reports that before
 * or after the frame's observer reports, by when the window lays it out:
 * during the task that shows the tab, or in the frame after. A window
 * without ResizeObserver, as jsdom is, tells nothing.
 */
export function watchHiding(
  frame: HTMLIFrameElement,
  doc: Document,
  signal: AbortSignal,
  hiding: Hiding,
): void {
  const owner = frame.ownerDocument.defaultView;
  if (!owner?.ResizeObserver || signal.aborted) return;
  let shown = frameShows(frame, doc);
  if (!shown) hiding.hid();
  // A frame resized while it shows is no frame shown again: it stays where it
  // is, which can be a place that the reader, the find bar, or the split
  // view's follower has just given it, and that Chromium has yet to report.
  const observer = new owner.ResizeObserver(() => {
    if (frameShows(frame, doc) === shown) return;
    shown = !shown;
    if (shown) hiding.shown();
    else hiding.hid();
  });
  observer.observe(frame);
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
}

/** A watch of whether an element of the view shows, from `watchElementHiding`. */
export interface ElementHiding {
  /**
   * Watches the element in the window that it is in now, after its tab moved
   * to another window, and tells `hiding` whether it shows now, if that
   * changed since the watch last told it.
   */
  moved(): void;
}

/**
 * Tells `hiding` when `element` is laid out with no size and when with a size
 * again, until `signal`, as watchHiding does for a frame: a source beside no
 * page that the view can reach, which Chromium lays out again as far down as
 * it was when its tab shows again, also where its lines wrap otherwise now,
 * and which reports no scroll for that (#189, #204). An element that has no
 * size when watched counts as hidden. The observer is made in the element's
 * own window, whose rendering reports the sizes of its elements; after the tab
 * moves to another window, `moved` watches it there. A window without
 * ResizeObserver, as jsdom is, tells nothing.
 */
export function watchElementHiding(
  element: HTMLElement,
  signal: AbortSignal,
  hiding: Hiding,
): ElementHiding {
  // In a new window, Obsidian 1.5.3 first lays the view out with no width,
  // and then at the window's width.
  const shows = (): boolean =>
    element.isConnected && element.clientHeight !== 0 && element.clientWidth !== 0;
  let shown = shows();
  const check = (): void => {
    if (signal.aborted || shows() === shown) return;
    shown = !shown;
    if (shown) hiding.shown();
    else hiding.hid();
  };
  let observing: { readonly win: Window; readonly observer: ResizeObserver } | null = null;
  /** Observes the element in its window, and says whether that window can tell. */
  const watch = (): boolean => {
    const win = element.ownerDocument.defaultView;
    if (signal.aborted || !win?.ResizeObserver) return false;
    if (win !== observing?.win) {
      observing?.observer.disconnect();
      observing = { win, observer: new win.ResizeObserver(check) };
      observing.observer.observe(element);
    }
    return true;
  };
  if (watch() && !shown) hiding.hid();
  signal.addEventListener("abort", () => observing?.observer.disconnect(), { once: true });
  return {
    moved: () => {
      if (watch()) check();
    },
  };
}
