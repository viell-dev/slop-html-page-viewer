import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { button, frame, Harness, type HtmlView } from "./support/harness";
import { resizeObservers } from "./support/observers";

async function showSource(data: string): Promise<HtmlView> {
  const harness = await Harness.load();
  const view = harness.newView();
  harness.open(view, "page.html", data);
  button(view, "Source").click();
  return view;
}

function lines(view: HtmlView): Element[] {
  return [...view.contentEl.querySelectorAll(".html-page-viewer__source-line")];
}

function tokens(line: Element): [string, string][] {
  const code = line.querySelector(".html-page-viewer__source-code");
  assert.ok(code);
  return [...code.childNodes].map((node) => [
    node instanceof HTMLElement ? node.className.replace("html-page-viewer__tok-", "") : "text",
    node.textContent ?? "",
  ]);
}

describe("source view", () => {
  it("replaces the frame with the source, and switches back", async () => {
    const view = await showSource("<p>Hello</p>");
    assert.equal(frame(view), null);
    assert.ok(view.contentEl.querySelector(".html-page-viewer__source"));

    button(view, "Rendered").click();
    assert.ok(frame(view));
    assert.equal(view.contentEl.querySelector(".html-page-viewer__source"), null);
  });

  for (const fixture of ["static.html", "interactive.html"]) {
    it(`shows every line of ${fixture} with its number and its text unchanged`, async () => {
      const data = fs.readFileSync(`test-fixtures/${fixture}`, "utf8");
      const view = await showSource(data);
      const expected = data.split("\n");
      const shown = lines(view);
      assert.equal(shown.length, expected.length);
      shown.forEach((line, index) => {
        assert.equal(
          line.querySelector(".html-page-viewer__line-number")?.textContent,
          String(index + 1),
        );
        assert.equal(
          line.querySelector(".html-page-viewer__source-code")?.textContent,
          expected[index],
        );
      });
    });
  }

  it("shows markup as text without creating HTML elements", async () => {
    const data = '<script>window.ran = true;</script><img src="x" onerror="window.ran = true">';
    const view = await showSource(data);
    const source = view.contentEl.querySelector(".html-page-viewer__source");
    assert.ok(source);
    assert.equal(source.querySelector("script, img"), null);
    assert.equal(source.querySelector(".html-page-viewer__source-code")?.textContent, data);
  });

  it("highlights tag names, attributes, values, and comments", async () => {
    const view = await showSource('<a href="notes.html" download>Notes</a> <!-- see also -->');
    assert.deepEqual(tokens(lines(view)[0]), [
      ["punctuation", "<"],
      ["tag", "a"],
      ["punctuation", " "],
      ["attr", "href"],
      ["punctuation", "="],
      ["string", '"notes.html"'],
      ["punctuation", " "],
      ["attr", "download"],
      ["punctuation", ">"],
      ["text", "Notes"],
      ["punctuation", "</"],
      ["tag", "a"],
      ["punctuation", ">"],
      ["text", " "],
      ["comment", "<!-- see also -->"],
    ]);
  });

  it("keeps a comment highlighted on the lines it continues on (#14)", async () => {
    const view = await showSource("<!-- A comment\n     over two lines -->");
    assert.deepEqual(tokens(lines(view)[1]), [["comment", "     over two lines -->"]]);
  });

  it("highlights attributes on the lines after the tag name (#14)", async () => {
    const view = await showSource('<img\n  src="photo.png"\n  alt="A photo">');
    assert.deepEqual(tokens(lines(view)[1]), [
      ["punctuation", "  "],
      ["attr", "src"],
      ["punctuation", "="],
      ["string", '"photo.png"'],
    ]);
    assert.deepEqual(tokens(lines(view)[2]), [
      ["punctuation", "  "],
      ["attr", "alt"],
      ["punctuation", "="],
      ["string", '"A photo"'],
      ["punctuation", ">"],
    ]);
  });

  it("keeps a quoted value highlighted on the lines it continues on", async () => {
    const view = await showSource('<p title="first\nsecond">Text</p>');
    assert.deepEqual(tokens(lines(view)[1]), [
      ["string", 'second"'],
      ["punctuation", ">"],
      ["text", "Text"],
      ["punctuation", "</"],
      ["tag", "p"],
      ["punctuation", ">"],
    ]);
  });

  it("keeps the spaces between attributes (#52)", async () => {
    for (const data of ["<input a b c>", "<input disabled >", '<a href = "x">y</a>']) {
      const view = await showSource(data);
      assert.equal(
        lines(view)[0].querySelector(".html-page-viewer__source-code")?.textContent,
        data,
      );
    }
    const view = await showSource("<input disabled hidden>");
    assert.deepEqual(tokens(lines(view)[0]), [
      ["punctuation", "<"],
      ["tag", "input"],
      ["punctuation", " "],
      ["attr", "disabled"],
      ["punctuation", " "],
      ["attr", "hidden"],
      ["punctuation", ">"],
    ]);
  });

  it("ends a tag at a > outside its quoted values (#53)", async () => {
    const view = await showSource('<p title="a > b">Text</p>');
    assert.deepEqual(tokens(lines(view)[0]).slice(3, 7), [
      ["attr", "title"],
      ["punctuation", "="],
      ["string", '"a > b"'],
      ["punctuation", ">"],
    ]);
  });

  it("highlights attribute names as HTML reads them (#53)", async () => {
    const view = await showSource('<a @click="go()" :class="c" [value]="v" #ref>');
    const names = tokens(lines(view)[0])
      .filter(([kind]) => kind === "attr")
      .map(([, text]) => text);
    assert.deepEqual(names, ["@click", ":class", "[value]", "#ref"]);
  });

  it("shows the contents of scripts and styles as text (#53)", async () => {
    const view = await showSource(
      '<script>\nif (a<b && c>d) go();\nfor (i = 0; i <n; i++) {}\n</SCRIPT>\n<style>a<b {}</style><p class="x">',
    );
    assert.deepEqual(tokens(lines(view)[1]), [["text", "if (a<b && c>d) go();"]]);
    assert.deepEqual(tokens(lines(view)[2]), [["text", "for (i = 0; i <n; i++) {}"]]);
    assert.deepEqual(tokens(lines(view)[3]), [
      ["punctuation", "</"],
      ["tag", "SCRIPT"],
      ["punctuation", ">"],
    ]);
    const last = tokens(lines(view)[4]);
    assert.deepEqual(last.slice(0, 4), [
      ["punctuation", "<"],
      ["tag", "style"],
      ["punctuation", ">"],
      ["text", "a<b {}"],
    ]);
    assert.ok(last.some(([kind, text]) => kind === "attr" && text === "class"));
  });

  it("starts a tag only at a < that HTML reads as markup (#53)", async () => {
    const view = await showSource("x < y, a<1, and <3");
    assert.deepEqual(tokens(lines(view)[0]), [["text", "x < y, a<1, and <3"]]);
  });

  it("ends comments and declarations where HTML does", async () => {
    const view = await showSource("<!-->a<!--->b<!-- c --!>d<!DOCTYPE html><?xml?>e");
    assert.deepEqual(tokens(lines(view)[0]), [
      ["comment", "<!-->"],
      ["text", "a"],
      ["comment", "<!--->"],
      ["text", "b"],
      ["comment", "<!-- c --!>"],
      ["text", "d"],
      ["punctuation", "<!DOCTYPE html><?xml?>"],
      ["text", "e"],
    ]);
  });

  it("shows any text unchanged, line by line", async () => {
    // Fragments of markup in random order, from a fixed seed.
    const pieces = [
      ...[
        "<",
        ">",
        "/",
        "!",
        "?",
        "-",
        "--",
        "=",
        '"',
        "'",
        " ",
        "\t",
        "\n",
        "a",
        "B",
        "1",
        "&amp;",
      ],
      ...["<!--", "-->", "--!>", "<!DOCTYPE", "<p ", "x=", "\r"],
      ...[
        "<script>",
        "</script>",
        "</SCRIPT ",
        "</scriptx>",
        "<style>",
        "</style>",
        "<title>",
        "<plaintext>",
      ],
    ];
    let seed = 1;
    const random = (limit: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % limit;
    };
    const harness = await Harness.load();
    for (let run = 0; run < 300; run += 1) {
      let data = "";
      const length = 1 + random(40);
      for (let piece = 0; piece < length; piece += 1) data += pieces[random(pieces.length)];
      // The view shows a message for a file of only whitespace.
      if (data.trim() === "") continue;
      const view = harness.newView();
      harness.open(view, "page.html", data);
      button(view, "Source").click();
      const shown = lines(view).map(
        (line) => line.querySelector(".html-page-viewer__source-code")?.textContent,
      );
      assert.deepEqual(shown, data.split("\n"), JSON.stringify(data));
    }
  });

  it("shows a file that ends inside a tag, a value, a comment, or a script unchanged", async () => {
    const page = '<!DOCTYPE html>\n<p class="a\nb" hidden>Text<!-- c\n--!><script>x<y</script >';
    const harness = await Harness.load();
    for (let end = 1; end <= page.length; end += 1) {
      const data = page.slice(0, end);
      const view = harness.newView();
      harness.open(view, "page.html", data);
      button(view, "Source").click();
      const shown = lines(view).map(
        (line) => line.querySelector(".html-page-viewer__source-code")?.textContent,
      );
      assert.deepEqual(shown, data.split("\n"), JSON.stringify(data));
    }
  });
});

describe("the source view's place after its tab moves (#135)", () => {
  /** Three lines, and eighty for tests whose lines wrap. */
  const SHORT = "<p>One</p>\n<p>Two</p>\n<p>Three</p>";
  const LONG = Array.from({ length: 80 }, (_, index) => `<p>Line ${index + 1}</p>`).join("\n");

  /**
   * The source view of a view in the document, with the scrolling, height,
   * and scrollTo of its source that Chromium would give it, which jsdom does
   * not lay out: its lines from 10 pixels down, each `lines.height` pixels
   * high, 20 to start with, with 10 pixels of padding below them, in a source
   * 400 pixels high and 600 wide, as `resize` and `widen` change them. Its
   * content is at least 2000 pixels high, so that three lines can be scrolled
   * as far as these tests scroll them. The reader's scrolling and scrollTo
   * report a scroll event, and `drop` shows it from its start without one, as
   * Chromium shows an element that Obsidian took out of the page and inserted
   * again. A source 0 pixels high is not laid out, and has no width either.
   * With `observers`, the view's window has ResizeObservers, which `report`
   * runs. With `scriptsOn`, pages open with scripts on.
   */
  async function movedSource(
    mode = "Source",
    {
      data = SHORT,
      observers = false,
      scriptsOn = false,
    }: { data?: string; observers?: boolean; scriptsOn?: boolean } = {},
  ): Promise<{
    harness: Harness;
    view: HtmlView & { onResize(): void };
    source: HTMLElement;
    lines: { height: number };
    scroll: (top: number, left?: number) => void;
    drop: () => void;
    jump: (top: number, left: number) => void;
    resize: (height: number) => void;
    widen: (width: number) => void;
    scrolledTo: ScrollToOptions[];
    report: () => void;
    observed: ReturnType<typeof resizeObservers>["observers"];
  }> {
    const observing = observers ? resizeObservers(window) : null;
    const harness = await Harness.load({ scriptsOn });
    const view = harness.newView() as HtmlView & { onResize(): void };
    document.body.append(view.contentEl);
    harness.open(view, "page.html", data);
    button(view, mode).click();
    const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
    const lines = { height: 20 };
    const count = data.split("\n").length;
    for (const [index, line] of source
      .querySelectorAll<HTMLElement>(".html-page-viewer__source-line")
      .entries())
      Object.defineProperties(line, {
        offsetTop: { configurable: true, get: () => 10 + index * lines.height },
        offsetHeight: { configurable: true, get: () => lines.height },
      });
    let top = 0;
    let left = 0;
    let height = 400;
    let width = 600;
    const scrolledTo: ScrollToOptions[] = [];
    const scroll = (toTop: number, toLeft = 0): void => {
      top = toTop;
      left = toLeft;
      source.dispatchEvent(new source.ownerDocument.defaultView!.Event("scroll"));
    };
    Object.defineProperties(source, {
      scrollTop: { configurable: true, get: () => top },
      scrollLeft: { configurable: true, get: () => left },
      scrollHeight: { configurable: true, get: () => Math.max(2000, 20 + count * lines.height) },
      clientHeight: { configurable: true, get: () => height },
      // Hidden, it has no width either.
      clientWidth: { configurable: true, get: () => (height === 0 ? 0 : width) },
      scrollTo: {
        configurable: true,
        value: (options: ScrollToOptions) => {
          scrolledTo.push(options);
          scroll(options.top ?? top, options.left ?? left);
        },
      },
    });
    return {
      harness,
      view,
      source,
      lines,
      scroll,
      drop: () => {
        top = 0;
        left = 0;
      },
      // Scrolls the source without its report, which Chromium sends in its
      // next frame.
      jump: (toTop: number, toLeft: number) => {
        top = toTop;
        left = toLeft;
      },
      resize: (to: number) => {
        height = to;
      },
      widen: (to: number) => {
        width = to;
      },
      scrolledTo,
      report: () => observing?.report(),
      observed: observing?.observers ?? [],
    };
  }

  const endObservers = (): void => {
    delete (window as { ResizeObserver?: unknown }).ResizeObserver;
  };

  it("goes back to where it was at Obsidian's next layout change", async () => {
    const { harness, scroll, drop, scrolledTo } = await movedSource();
    scroll(571, 40);
    drop();
    harness.app.workspace.trigger("layout-change");
    assert.deepEqual(scrolledTo, [{ top: 571, left: 40, behavior: "instant" }]);
    harness.app.workspace.trigger("layout-change");
    assert.equal(scrolledTo.length, 1, "it is where it was, once there");
  });

  it("goes back once a new window has laid it out and resizes the view", async () => {
    const { harness, view, scroll, drop, resize, scrolledTo } = await movedSource();
    scroll(571);
    drop();
    resize(0);
    harness.app.workspace.trigger("layout-change");
    assert.deepEqual(scrolledTo, [], "a source that is not laid out has nothing to scroll");
    resize(400);
    view.onResize();
    assert.deepEqual(scrolledTo, [{ top: 571, left: 0, behavior: "instant" }]);
  });

  it("stays where the reader scrolls it, also back to its start", async () => {
    const { harness, view, scroll, scrolledTo } = await movedSource();
    scroll(571);
    scroll(200);
    harness.app.workspace.trigger("layout-change");
    scroll(0);
    harness.app.workspace.trigger("layout-change");
    view.onResize();
    assert.deepEqual(scrolledTo, []);
  });

  it("puts the split view's source back too, at the layout change (#157)", async () => {
    const { harness, view, scroll, drop, scrolledTo } = await movedSource("Split");
    scroll(571);
    drop();
    harness.app.workspace.trigger("layout-change");
    view.onResize();
    assert.deepEqual(scrolledTo, [{ top: 571, left: 0, behavior: "instant" }]);
  });

  it("starts a source shown again from its top", async () => {
    const { harness, view, scroll, scrolledTo } = await movedSource();
    scroll(571);
    button(view, "Rendered").click();
    button(view, "Source").click();
    harness.app.workspace.trigger("layout-change");
    assert.deepEqual(scrolledTo, []);
  });

  /**
   * Animation frames for the view's window, which jsdom does not have, that
   * run only when `frame` says, until `end`. Chromium reports a frame's
   * scrolling before its animation frame callbacks.
   */
  function animationFrames(): { frame: () => void; end: () => void } {
    const callbacks: FrameRequestCallback[] = [];
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => callbacks.push(callback),
    });
    return {
      frame: () => {
        for (const callback of callbacks.splice(0)) callback(0);
      },
      end: () => {
        delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      },
    };
  }

  // Each kind of the reader's input that the view listens for. Of real input,
  // a key that scrolls the source in one step, such as Home on Obsidian 1.5.3,
  // gives the late report of its scroll that these stand in for.
  const readerInput: Record<string, () => Event> = {
    keydown: () => new window.KeyboardEvent("keydown", { bubbles: true, key: "Home" }),
    "keydown with Control held": () =>
      new window.KeyboardEvent("keydown", { bubbles: true, key: "Home", ctrlKey: true }),
    pointerdown: () => new window.Event("pointerdown", { bubbles: true }),
    touchstart: () => new window.Event("touchstart", { bubbles: true }),
    wheel: () => new window.WheelEvent("wheel", { bubbles: true, deltaY: -600 }),
  };

  for (const mode of ["Source", "Split"]) {
    for (const trigger of ["layout-change", "resize"] as const) {
      for (const [input, event] of Object.entries(readerInput)) {
        it(`leaves the ${mode === "Split" ? "split" : "source"} view's source at its start where the reader scrolls it with ${input}, when a ${trigger === "resize" ? "resize" : "layout change"} comes before Chromium reports it (#157)`, async () => {
          const { harness, view, scroll, drop, scrolledTo } = await movedSource(mode);
          const frames = animationFrames();
          try {
            scroll(571);
            const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
            // The reader's input scrolls the source to its start in one step;
            // Chromium reports the scroll only in its next frame.
            source.dispatchEvent(event());
            drop();
            if (trigger === "resize") view.onResize();
            else harness.app.workspace.trigger("layout-change");
            assert.deepEqual(scrolledTo, [], "not sent back while the scroll is unreported");
            scroll(0);
            frames.frame();
            harness.app.workspace.trigger("layout-change");
            view.onResize();
            assert.deepEqual(scrolledTo, [], "and it is at its start once reported");
          } finally {
            frames.end();
          }
        });
      }
    }
  }

  it("goes back after the reader's input that scrolled nothing, once Chromium's next frame has passed (#157)", async () => {
    const { harness, view, scroll, drop, scrolledTo } = await movedSource();
    const frames = animationFrames();
    try {
      scroll(571);
      const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
      source.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
      frames.frame();
      drop();
      harness.app.workspace.trigger("layout-change");
      assert.deepEqual(scrolledTo, [{ top: 571, left: 0, behavior: "instant" }]);
    } finally {
      frames.end();
    }
  });

  it("goes back after a modifier key in it, which scrolls nothing, as a hotkey that moves the tab sends in the same frame (#167)", async () => {
    for (const key of ["Control", "Shift", "Alt", "AltGraph", "Meta"]) {
      const { harness, view, scroll, drop, scrolledTo } = await movedSource();
      const frames = animationFrames();
      try {
        scroll(571);
        const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
        source.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key }));
        drop();
        harness.app.workspace.trigger("layout-change");
        assert.deepEqual(scrolledTo, [{ top: 571, left: 0, behavior: "instant" }], key);
      } finally {
        frames.end();
      }
    }
  });

  /**
   * Has the view's find bar scroll the source to `match` in one step, as
   * Chromium does at once and reports in its next frame, and returns the
   * find bar's field. jsdom scrolls nothing into view.
   */
  function findScrolling(view: HtmlView, match: string, to: () => void): HTMLInputElement {
    Object.defineProperty(window.Element.prototype, "scrollIntoView", {
      configurable: true,
      value: to,
    });
    button(view, "Find in page").click();
    const field = view.contentEl.querySelector<HTMLInputElement>(".html-page-viewer__find input")!;
    field.value = match;
    field.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    return field;
  }

  function endFindScrolling(field: HTMLInputElement): void {
    delete (window.Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    field.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  }

  for (const mode of ["Source", "Split"]) {
    for (const trigger of ["layout-change", "resize"] as const) {
      it(`leaves the ${mode === "Split" ? "split" : "source"} view's source at its start where the find bar scrolls it, when a ${trigger === "resize" ? "resize" : "layout change"} comes before Chromium reports it (#167)`, async () => {
        const { harness, view, scroll, drop, scrolledTo } = await movedSource(mode);
        scroll(571);
        // The first line's match is at the source's start.
        const field = findScrolling(view, "One", drop);
        try {
          if (trigger === "resize") view.onResize();
          else harness.app.workspace.trigger("layout-change");
          assert.deepEqual(scrolledTo, [], "not sent back while the scroll is unreported");
          scroll(0);
          harness.app.workspace.trigger("layout-change");
          view.onResize();
          assert.deepEqual(scrolledTo, [], "and it is at its start once reported");
        } finally {
          endFindScrolling(field);
        }
      });
    }
  }

  it("goes back to where the find bar put the source, when its tab moves before Chromium reports that scroll (#167)", async () => {
    const { harness, view, scroll, drop, jump, scrolledTo } = await movedSource();
    scroll(571);
    // The find bar scrolls the source to a match further down, and the tab
    // moves before Chromium reports that scroll.
    const field = findScrolling(view, "Two", () => jump(300, 7));
    try {
      drop();
      harness.app.workspace.trigger("layout-change");
      assert.deepEqual(scrolledTo, [{ top: 300, left: 7, behavior: "instant" }]);
    } finally {
      endFindScrolling(field);
    }
  });

  it("keeps its place where the find bar scrolls a source that is not laid out, which scrolls nothing (#167)", async () => {
    const { view, scroll, drop, resize, scrolledTo } = await movedSource();
    scroll(571);
    drop();
    resize(0);
    const field = findScrolling(view, "One", () => undefined);
    try {
      resize(400);
      view.onResize();
      assert.deepEqual(scrolledTo, [{ top: 571, left: 0, behavior: "instant" }]);
    } finally {
      endFindScrolling(field);
    }
  });

  it("goes back after the reader's input once the element has reported a scroll since (#157)", async () => {
    const { harness, view, scroll, drop, scrolledTo } = await movedSource();
    const frames = animationFrames();
    try {
      const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
      source.dispatchEvent(new window.Event("keydown", { bubbles: true }));
      scroll(571);
      drop();
      harness.app.workspace.trigger("layout-change");
      assert.deepEqual(scrolledTo, [{ top: 571, left: 0, behavior: "instant" }]);
    } finally {
      frames.end();
    }
  });

  // Its lines wrap onto twice as many rows in a pane half as wide: line 15,
  // which was 300 pixels down, is 590 pixels down there.
  it("goes back to the line at its top after a move to a pane where its lines wrap otherwise (#189)", async () => {
    const { harness, lines, scroll, drop, scrolledTo } = await movedSource("Source", {
      data: LONG,
    });
    scroll(300);
    drop();
    lines.height = 40;
    harness.app.workspace.trigger("layout-change");
    assert.deepEqual(scrolledTo, [{ top: 590, left: 0, behavior: "instant" }]);
    harness.app.workspace.trigger("layout-change");
    assert.equal(scrolledTo.length, 1, "it is at its line, once there");
  });

  it("goes back to its line where Obsidian puts it back as far down as it was, or at its end short of that (#189)", async () => {
    const { lines, scroll, scrolledTo } = await movedSource("Source", { data: LONG });
    scroll(300);
    lines.height = 40;
    scroll(300);
    assert.deepEqual(scrolledTo, [{ top: 590, left: 0, behavior: "instant" }]);

    // Line 41 in a narrow pane, then a wide one, where its end is 1600
    // pixels down.
    scroll(1630);
    lines.height = 20;
    scroll(1600);
    assert.deepEqual(scrolledTo.at(-1), { top: 820, left: 0, behavior: "instant" });
    assert.equal(scrolledTo.length, 2);
  });

  it("stays where the reader scrolls it up to a place short of its end (#189)", async () => {
    const { scroll, scrolledTo } = await movedSource("Source", { data: LONG });
    scroll(1000);
    scroll(500);
    scroll(500, 30);
    assert.deepEqual(scrolledTo, []);
  });

  // The split view with scripts on has no page that the view can reach, so its
  // source goes back as the Source view's does (#204).
  for (const mode of ["Source", "Split"]) {
    const scriptsOn = mode === "Split";
    const issue = scriptsOn ? "with scripts on, #204" : "#189";
    const options = { data: LONG, observers: true, scriptsOn };

    // Chromium lays the source out again as far down as it was when its tab
    // shows again, which shows other lines where its pane changed width, and
    // reports no scroll for that.
    it(`goes back to its line when its tab shows again after its pane changed width while hidden (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      try {
        const { lines, scroll, jump, resize, scrolledTo, report, observed, source } = shown;
        assert.equal(observed.length, 1, "an observer of its window");
        assert.deepEqual(observed[0].observed, [source]);
        // A window's first report gives the size that the source has then.
        report();
        scroll(300);
        resize(0);
        report();
        // Chromium scrolls a hidden element to its start, and reports nothing.
        jump(0, 0);
        lines.height = 40;
        jump(300, 0);
        resize(400);
        report();
        assert.deepEqual(scrolledTo, [{ top: 590, left: 0, behavior: "instant" }]);
        // A resize while it shows is no showing again: Chromium's scroll
        // anchoring keeps its lines there.
        resize(380);
        report();
        assert.equal(scrolledTo.length, 1);
      } finally {
        endObservers();
      }
    });

    // In a new window, Obsidian 1.5.3 first lays the view out with no width,
    // where each line is as high as its characters are many.
    it(`takes its source for shown only once it has a width (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      try {
        const { lines, scroll, jump, resize, widen, scrolledTo, report } = shown;
        report();
        scroll(300);
        resize(0);
        report();
        widen(0);
        lines.height = 900;
        jump(0, 0);
        resize(400);
        report();
        widen(600);
        lines.height = 40;
        jump(300, 0);
        report();
        assert.deepEqual(scrolledTo, [{ top: 590, left: 0, behavior: "instant" }]);
      } finally {
        endObservers();
      }
    });

    it(`keeps no scroll that its source reports while hidden (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      try {
        const { scroll, jump, resize, scrolledTo, report } = shown;
        report();
        scroll(300);
        resize(0);
        report();
        // As Chromium lays it out somewhere as the tab shows, and reports that
        // before the observer reports.
        resize(400);
        scroll(40);
        report();
        assert.deepEqual(scrolledTo, [{ top: 300, left: 0, behavior: "instant" }]);
        jump(300, 0);
      } finally {
        endObservers();
      }
    });

    it(`watches its source in the window that its tab moved to, at the layout change there (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      const popout = new JSDOM("<!doctype html><html><body></body></html>")
        .window as unknown as Window;
      try {
        const { harness, view, lines, scroll, resize, scrolledTo, report, observed, source } =
          shown;
        const moved = resizeObservers(popout);
        report();
        scroll(300);
        // A layout change in the window that it shows in watches no lines.
        harness.app.workspace.trigger("layout-change");
        assert.equal(observed.length, 1);
        popout.document.body.append(popout.document.adoptNode(view.contentEl));
        harness.app.workspace.trigger("layout-change");
        assert.equal(observed[0].connected, false, "not by its first window");
        // One observes the source, and one its lines, for Obsidian's styles.
        assert.deepEqual(
          moved.observers.map((observer) => observer.observed),
          [[source], [source.querySelector("pre")]],
        );
        resize(0);
        moved.report();
        lines.height = 40;
        resize(400);
        moved.report();
        assert.deepEqual(scrolledTo, [{ top: 590, left: 0, behavior: "instant" }]);
      } finally {
        endObservers();
        (popout as unknown as { close(): void }).close();
      }
    });

    it(`tells the layout change a showing that its first window's watch did not report, after a move (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      const popout = new JSDOM("<!doctype html><html><body></body></html>")
        .window as unknown as Window;
      try {
        const { harness, view, lines, scroll, resize, scrolledTo, report } = shown;
        resizeObservers(popout);
        report();
        scroll(300);
        // Its tab hides, and moves to a new window, where it shows again before
        // anything observes it there.
        resize(0);
        report();
        popout.document.body.append(popout.document.adoptNode(view.contentEl));
        lines.height = 40;
        resize(400);
        harness.app.workspace.trigger("layout-change");
        assert.deepEqual(scrolledTo, [{ top: 590, left: 0, behavior: "instant" }]);
      } finally {
        endObservers();
        (popout as unknown as { close(): void }).close();
      }
    });

    // Obsidian 1.5.3 lays a new window's elements out before its styles arrive
    // there, and the source's lines then take other heights under it (#165).
    it(`goes back to its line when the lines of its source change size soon after a move to a new window (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      const popout = new JSDOM("<!doctype html><html><body></body></html>")
        .window as unknown as Window;
      try {
        const { harness, view, source, lines, scroll, scrolledTo, report } = shown;
        const moved = resizeObservers(popout);
        const pre = source.querySelector("pre")!;
        Object.defineProperties(pre, {
          offsetWidth: { configurable: true, value: 600 },
          offsetHeight: { configurable: true, get: () => 20 + 80 * lines.height },
        });
        report();
        scroll(300);
        popout.document.body.append(popout.document.adoptNode(view.contentEl));
        harness.app.workspace.trigger("layout-change");
        // A window's first report gives the sizes that the elements have then.
        moved.report();
        assert.deepEqual(scrolledTo, []);
        lines.height = 40;
        moved.report();
        assert.deepEqual(scrolledTo, [{ top: 590, left: 0, behavior: "instant" }], "line 15");
        // Where the reader scrolls it then, to line 18, it keeps their line.
        scroll(700);
        lines.height = 20;
        moved.report();
        assert.deepEqual(scrolledTo.at(-1), { top: 355, left: 0, behavior: "instant" });
        // In the window that it was in, nothing watches its lines.
        shown.observed[0].callback();
        assert.equal(scrolledTo.length, 2);
      } finally {
        endObservers();
        (popout as unknown as { close(): void }).close();
      }
    });

    // Obsidian puts the source back, and the new window lays it out at another
    // height before Chromium reports that: it is neither as far down as it was
    // nor at its end then.
    it(`goes back to its line at its first scroll report in a new window (${issue}, #218)`, async () => {
      const shown = await movedSource(mode, options);
      const popout = new JSDOM("<!doctype html><html><body></body></html>")
        .window as unknown as Window;
      try {
        const { harness, view, scroll, scrolledTo, report } = shown;
        resizeObservers(popout);
        report();
        scroll(300);
        popout.document.body.append(popout.document.adoptNode(view.contentEl));
        harness.app.workspace.trigger("layout-change");
        scroll(500);
        assert.deepEqual(scrolledTo, [{ top: 300, left: 0, behavior: "instant" }]);
      } finally {
        endObservers();
        (popout as unknown as { close(): void }).close();
      }
    });

    // A scroll that the reader has made and that Chromium has yet to report
    // is theirs, also where the lines change size meanwhile.
    it(`leaves its source where the reader's input in it can still be unreported, when its lines change size after a move to a new window (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      const popout = new JSDOM("<!doctype html><html><body></body></html>")
        .window as unknown as Window;
      try {
        const { harness, view, source, lines, scroll, scrolledTo, report } = shown;
        const moved = resizeObservers(popout);
        // Frames that never run, so that the input stays unreported.
        Object.defineProperty(popout, "requestAnimationFrame", {
          configurable: true,
          value: () => 0,
        });
        const pre = source.querySelector("pre")!;
        Object.defineProperties(pre, {
          offsetWidth: { configurable: true, value: 600 },
          offsetHeight: { configurable: true, get: () => 20 + 80 * lines.height },
        });
        report();
        scroll(300);
        popout.document.body.append(popout.document.adoptNode(view.contentEl));
        harness.app.workspace.trigger("layout-change");
        moved.report();
        const inPopout = popout as unknown as typeof globalThis;
        source.dispatchEvent(new inPopout.WheelEvent("wheel", { bubbles: true, deltaY: 200 }));
        lines.height = 40;
        moved.report();
        assert.deepEqual(scrolledTo, []);
      } finally {
        endObservers();
        (popout as unknown as { close(): void }).close();
      }
    });

    it(`stops watching its source when the view shows another source or none (${issue})`, async () => {
      const shown = await movedSource(mode, options);
      try {
        const { view, observed } = shown;
        button(view, "Rendered").click();
        assert.equal(observed[0].connected, false);
        button(view, mode).click();
        assert.deepEqual(
          observed.map((observer) => observer.connected),
          [false, true],
        );
      } finally {
        endObservers();
      }
    });
  }
});
