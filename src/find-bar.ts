// The view's find bar (#13): its field and buttons, the text typed into it, and
// its place among the matches that find.ts finds and highlights. All of that
// state is here; the view says what there is to find in, and when it shows
// something else.

import { createIconButton } from "./buttons";
import { findRanges, Highlighter, type TextRun } from "./find";

/** The text to find in, and the window that shows it. */
export interface FindTarget {
  readonly runs: TextRun[];
  readonly win: Window | null;
}

/** The view, as its find bar uses it. */
export interface FindHost {
  readonly contentEl: HTMLElement;
  /**
   * What the view shows, to find `query` in: null while there is nothing to
   * search yet, and a message where the view cannot search.
   */
  findTarget(query: string): FindTarget | string | null;
  /** Gives the keys to what the view shows. */
  focusShown(): void;
  /** The find bar has scrolled what the view shows to a match. */
  scrolledToMatch(): void;
}

/** The find bar of one view, which keeps its state when the view shows the page again. */
export class FindBar {
  private isOpen = false;
  private query = "";
  private index = 0;
  private matches: Range[] = [];
  private more = false;
  private highlighter: Highlighter | null = null;
  private bar: HTMLElement | null = null;
  /** The delay before it searches what was typed, with the window that runs it (#175). */
  private timer: { readonly win: Window; readonly id: number } | null = null;

  constructor(private readonly host: FindHost) {}

  /** Opens the bar, or focuses it if it is open, with its text selected. */
  open(): void {
    if (!this.isOpen) {
      this.isOpen = true;
      const header = this.host.contentEl.querySelector(".html-page-viewer__header");
      if (header) {
        this.bar = this.render(this.host.contentEl);
        header.after(this.bar);
      }
      this.run();
    }
    const input = this.bar?.querySelector("input");
    input?.focus();
    input?.select();
  }

  /** Closes the bar; given `refocus`, the keys go back to what the view shows. */
  close(refocus = false): void {
    this.flushInput();
    this.isOpen = false;
    this.clearMatches();
    this.bar?.remove();
    this.bar = null;
    if (refocus) this.host.focusShown();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /**
   * For when the view empties what it shows, with the bar in it: keeps the
   * text typed into it, and clears its matches.
   */
  detach(): void {
    this.flushInput();
    this.clearMatches();
    this.bar = null;
  }

  /** Shows the bar in `parent`, after `detach`, if it is open. */
  attach(parent: HTMLElement): void {
    if (this.isOpen) this.bar = this.render(parent);
  }

  /** For when the view closes: nothing is searched or highlighted any more. */
  end(): void {
    this.cancelTimer();
    this.clearMatches();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    // Only the window that set a timer can clear it, and the view can be in
    // another one by now, after its tab moved (#175).
    this.timer.win.clearTimeout(this.timer.id);
    this.timer = null;
  }

  /** Takes the text typed into the bar before the bar is replaced, if it has not been searched yet. */
  private flushInput(): void {
    if (this.timer === null) return;
    this.cancelTimer();
    const input = this.bar?.querySelector("input");
    if (input && input.value !== this.query) {
      this.query = input.value;
      this.index = 0;
    }
  }

  private render(parent: HTMLElement): HTMLElement {
    const bar = parent.createDiv({ cls: "html-page-viewer__find" });
    const input = bar.createEl("input", {
      attr: {
        type: "search",
        placeholder: "Find",
        "aria-label": "Find in page",
        spellcheck: "false",
      },
    });
    input.value = this.query;
    bar.createSpan({ cls: "html-page-viewer__find-count", attr: { "aria-live": "polite" } });
    const previous = createIconButton(bar, "chevron-up", "Previous match");
    const next = createIconButton(bar, "chevron-down", "Next match");
    const close = createIconButton(bar, "x", "Close find");

    input.addEventListener("input", () => {
      // Searching a long page at every key would make typing lag.
      this.cancelTimer();
      // The window that shows the bar now: after its tab moved, the window
      // that the bar was made in can be another one, or closed (#175).
      const win = input.ownerDocument.defaultView;
      if (!win) return;
      const id = win.setTimeout(() => {
        this.timer = null;
        if (!this.host.contentEl.contains(input)) return;
        this.query = input.value;
        this.index = 0;
        this.run();
      }, 150);
      this.timer = { win, id };
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.cancelTimer();
        if (input.value !== this.query) {
          this.query = input.value;
          this.index = 0;
          this.run();
        } else {
          this.move(event.shiftKey ? -1 : 1);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close(true);
      }
    });
    previous.addEventListener("click", () => this.move(-1));
    next.addEventListener("click", () => this.move(1));
    close.addEventListener("click", () => this.close());
    return bar;
  }

  /**
   * Finds the bar's text in what the view shows, and shows the current match,
   * also by scrolling to it unless `reveal` is false.
   */
  run(reveal = true): void {
    // Not for a bar that the view has replaced.
    if (!this.isOpen || !this.bar || !this.host.contentEl.contains(this.bar)) return;
    this.clearMatches();
    const target = this.host.findTarget(this.query);
    if (target === null || typeof target === "string") {
      this.setCount(target ?? "");
      return;
    }
    const { ranges, more } = findRanges(target.runs, this.query);
    this.matches = ranges;
    this.more = more;
    this.highlighter = new Highlighter(target.win);
    this.index = Math.min(this.index, Math.max(ranges.length - 1, 0));
    this.showMatch(true, reveal);
  }

  /**
   * Finds its matches again, without scrolling to the current one, if they no
   * longer show in `win`, the window that the view is in now (#162).
   */
  restoreIn(win: Window | null): void {
    if (this.highlighter?.lostIn(win)) this.run(false);
  }

  private move(step: number): void {
    const count = this.matches.length;
    if (count === 0) return;
    this.index = (this.index + step + count) % count;
    this.showMatch(false);
  }

  /** Shows the current match, and with `all`, every match, scrolling to it with `reveal`. */
  private showMatch(all = true, reveal = true): void {
    const count = this.matches.length;
    const current = this.matches[this.index] ?? null;
    if (all) this.highlighter?.show(this.matches, current);
    else this.highlighter?.setCurrent(current);
    if (count === 0) {
      this.setCount(this.query === "" ? "" : "No matches");
    } else {
      this.setCount(`${this.index + 1} of ${count}${this.more ? "+" : ""}`);
    }
    if (current && reveal) {
      scrollToRange(current);
      this.host.scrolledToMatch();
    }
  }

  private setCount(text: string): void {
    const count = this.bar?.querySelector(".html-page-viewer__find-count");
    if (count) count.textContent = text;
  }

  private clearMatches(): void {
    this.highlighter?.clear();
    this.highlighter = null;
    this.matches = [];
    this.more = false;
  }
}

/**
 * Scrolls a match into view: its element first, as nested scrolling areas need,
 * and then the window, as the element can be taller than the window, as a
 * `<pre>` or a page's text directly in its body is.
 */
function scrollToRange(range: Range): void {
  (
    range.startContainer.parentElement?.closest("select") ?? range.startContainer.parentElement
  )?.scrollIntoView?.({ block: "center", inline: "nearest" });
  const win = range.startContainer.ownerDocument?.defaultView;
  const box = range.getBoundingClientRect?.();
  if (!win || !box || (box.width === 0 && box.height === 0)) return;
  if (box.top < 0 || box.bottom > win.innerHeight) win.scrollBy(0, box.top - win.innerHeight / 2);
}
