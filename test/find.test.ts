import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { CURRENT_HIGHLIGHT, findRanges, MATCH_HIGHLIGHT, pageRuns, sourceRuns } from "../src/find";
import { button, Harness, type HtmlView, loadFrame, settle } from "./support/harness";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function texts(html: string, query: string): string[] {
  return findRanges(pageRuns(parse(html)), query).ranges.map((range) => range.toString());
}

describe("finding text in a page", () => {
  it("excludes nonpainted fallback and SVG resources, but keeps SVG text", () => {
    assert.deepEqual(texts("<svg><foreignObject>needle</foreignObject></svg>", "needle"), [
      "needle",
    ]);
    const hidden =
      "<iframe>needle</iframe><progress>needle</progress><meter>needle</meter>" +
      "<svg>needle" +
      ["defs", "symbol", "clipPath", "mask", "pattern", "marker"]
        .map((tag) => "<" + tag + "><text>needle</text></" + tag + ">")
        .join("") +
      "</svg>";
    assert.deepEqual(texts(hidden, "needle"), []);
    assert.deepEqual(texts("<svg><g><text>needle</text></g></svg>", "needle"), ["needle"]);
    assert.deepEqual(
      findRanges(
        pageRuns(styled('<canvas style="content-visibility:hidden">needle</canvas>')),
        "needle",
      ).ranges,
      [],
    );
  });
  it("finds only a closed select's chosen text", () => {
    assert.deepEqual(
      texts("<select><option>other</option><option selected>needle</option></select>", "needle"),
      ["needle"],
    );
    assert.deepEqual(
      texts("<select><option selected>other</option><option>needle</option></select>", "needle"),
      [],
    );
  });
  it("excludes unsupported select labels and separates control runs", () => {
    for (const attributes of ["multiple", 'size="3"', 'style="visibility:hidden"']) {
      assert.deepEqual(
        findRanges(
          pageRuns(styled(`<select ${attributes}><option>needle</option></select>`)),
          "needle",
        ).ranges,
        [],
      );
    }
    assert.deepEqual(texts('<select><option label="other">needle</option></select>', "needle"), []);
    for (const query of ["foobar", "barbaz"]) {
      assert.deepEqual(texts("<p>foo<select><option>bar</option></select>baz</p>", query), []);
    }
  });
  it("walks composed shadow content once, keeping ranges in one tree", () => {
    const doc = parse('<div id="host"><span slot="named">slotted</span><b>unassigned</b></div>');
    const shadow = doc.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = 'before<slot name="named">fallback</slot>after<div id="nested"></div>';
    shadow.getElementById("nested")!.attachShadow({ mode: "open" }).innerHTML =
      "<p>nested <em>word</em></p>";
    const runs = pageRuns(doc);
    for (const word of ["before", "slotted", "after", "nested word"])
      assert.equal(findRanges(runs, word).ranges[0]?.toString(), word);
    for (const word of ["unassigned", "fallback", "beforeslotted", "slottedafter"])
      assert.deepEqual(findRanges(runs, word).ranges, []);
  });
  it("ignores case, and finds a match across elements within a block", () => {
    assert.deepEqual(texts("<p>Saved <b>Pa</b>ge, saved page</p>", "saved page"), [
      "Saved Page",
      "saved page",
    ]);
  });

  it("finds no match from one block into the next", () => {
    assert.deepEqual(
      texts("<p>first</p><p>second</p><div>third<br>fourth</div>", "firstsecond"),
      [],
    );
    assert.deepEqual(texts("<div>third<br>fourth</div>", "thirdfourth"), []);
    assert.deepEqual(texts("<ul><li>one</li><li>two</li></ul>", "onetwo"), []);
  });

  it("leaves out text the page does not show", () => {
    const html = [
      "<p>shown</p><script>var shown;</script><style>.shown {}</style><template>shown</template>",
      "<video>shown</video><audio>shown</audio><div hidden>shown</div><details><summary>Open</summary>shown<p>shown</p></details>",
    ].join("");
    assert.deepEqual(texts(html, "shown"), ["shown"]);
    assert.deepEqual(texts("<details><summary>Open</summary>more</details>", "open"), ["Open"]);
    assert.deepEqual(texts("<details open><summary>Open</summary>more</details>", "more"), [
      "more",
    ]);
  });

  it("finds a canvas's fallback text, which a page with scripts off shows", () => {
    assert.deepEqual(texts("<canvas>Chart <b>of</b> sales</canvas>", "chart of sales"), [
      "Chart of sales",
    ]);
  });

  /** A page whose computed styles the window can read, as a page in Obsidian's frame. */
  function styled(html: string): Document {
    const doc = parse(html);
    Object.defineProperty(doc, "defaultView", { value: window });
    return doc;
  }

  it("uses computed styles when checkVisibility is unavailable", () => {
    const doc = styled(
      `<p style="visibility:hidden">hidden<span style="visibility:visible">shown</span></p><div style="opacity:0"><span style="opacity:1">hidden</span></div><div style="display:none">hidden</div><div style="display:contents">shown</div><div style="display:contents;opacity:0">shown<span>shown</span></div>`,
    );
    assert.deepEqual(findRanges(pageRuns(doc), "hidden").ranges, []);
    assert.equal(findRanges(pageRuns(doc), "shown").ranges.length, 4);
    assert.deepEqual(
      findRanges(pageRuns(styled(`<html style="opacity:0"><p>hidden</p></html>`)), "hidden").ranges,
      [],
    );
  });

  it("leaves out what content-visibility hides, where it applies", () => {
    const doc = styled(
      `<div style="content-visibility:hidden">hidden<p>hidden</p></div><table><tr><td style="content-visibility:hidden">hidden</td></tr></table>` +
        `<span style="content-visibility:hidden">shown</span><div style="display:contents;content-visibility:hidden">shown</div><table style="content-visibility:hidden"><tr><td>shown</td></tr></table>`,
    );
    assert.deepEqual(findRanges(pageRuns(doc), "hidden").ranges, []);
    assert.equal(findRanges(pageRuns(doc), "shown").ranges.length, 3);
  });

  it("finds the text of noscript, which a page with scripts off shows", () => {
    // With scripts off, the parser reads noscript's contents as markup.
    const doc = new DOMParser().parseFromString(
      "<noscript><p>Enable JavaScript</p></noscript>",
      "text/html",
    );
    assert.deepEqual(findRanges(pageRuns(doc), "javascript").ranges.map(String), ["JavaScript"]);
  });

  it("matches any run of whitespace, as a page shows it, for a space in the query", () => {
    const html = "<p>Saved\n    page, Saved&nbsp;page, Saved\tpage, <b>Saved</b>\n<i>page</i></p>";
    assert.deepEqual(texts(html, "saved page"), [
      "Saved\n    page",
      "Saved page",
      "Saved\tpage",
      "Saved\npage",
    ]);
  });

  it("finds a query as text, not as a pattern", () => {
    assert.deepEqual(texts("<p>a.b axb (c) [d] \\e /f/ a-b</p>", "a.b"), ["a.b"]);
    assert.deepEqual(texts("<p>(c) [d] \\e /f/ a-b $1</p>", "(c) [d] \\e /f/ a-b $1"), [
      "(c) [d] \\e /f/ a-b $1",
    ]);
    assert.deepEqual(texts("<p>Éclair éclair</p>", "éCLAIR"), ["Éclair", "éclair"]);
  });

  it("finds at most a limit of matches, and says there were more", () => {
    const runs = pageRuns(parse(`<p>${"x ".repeat(20)}</p>`));
    const { ranges, more } = findRanges(runs, "x", 5);
    assert.equal(ranges.length, 5);
    assert.equal(more, true);
    assert.equal(findRanges(runs, "x", 20).more, false);
    assert.deepEqual(findRanges(runs, "").ranges, []);
  });

  it("maps a match back to the text nodes it spans", () => {
    const doc = parse("<p>ab<i>cd</i>ef</p>");
    const [range] = findRanges(pageRuns(doc), "bcde").ranges;
    assert.equal(range.startContainer.textContent, "ab");
    assert.equal(range.startOffset, 1);
    assert.equal(range.endContainer.textContent, "ef");
    assert.equal(range.endOffset, 1);
  });

  it("maps a match that ends where its node ends, past empty nodes", () => {
    const doc = parse("<p></p>");
    const paragraph = doc.querySelector("p")!;
    for (const text of ["ab", "", "cd", ""]) paragraph.append(doc.createTextNode(text));
    const [first] = findRanges(pageRuns(doc), "ab").ranges;
    assert.equal(first.endContainer.textContent, "ab");
    assert.equal(first.endOffset, 2);
    const [second] = findRanges(pageRuns(doc), "cd").ranges;
    assert.equal(second.startContainer.textContent, "cd");
    assert.equal(second.startOffset, 0);
    assert.equal(findRanges(pageRuns(doc), "bc").ranges[0]?.toString(), "bc");
  });

  it("finds text in a source view line by line", () => {
    const doc = parse(
      `<div class="src"><div><span class="html-page-viewer__source-code"><span>&lt;</span><span>p</span>&gt;one</span></div>` +
        `<div><span class="html-page-viewer__source-code">two</span></div></div>`,
    );
    const runs = sourceRuns(doc.querySelector(".src")!);
    assert.deepEqual(
      runs.map((run) => run.text),
      ["<p>one", "two"],
    );
    assert.deepEqual(findRanges(runs, "p>o").ranges.map(String), ["p>o"]);
    assert.deepEqual(findRanges(runs, "onetwo").ranges, []);
  });
});

// jsdom does not load a frame's srcdoc, so finding in the rendered page is tested
// in Obsidian, in test/e2e/specs/find.e2e.ts.
describe("the find bar", () => {
  const PAGE =
    "<!doctype html>\n<title>Notes</title>\n<p>A saved page about pages.</p>\n<p>Page three.</p>";

  function highlights(): Map<string, Set<Range>> {
    return (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights;
  }

  function highlighted(name: string): string[] {
    return [...(highlights().get(name) ?? [])].map(String);
  }

  function count(view: HtmlView): string | null {
    return view.contentEl.querySelector(".html-page-viewer__find-count")?.textContent ?? null;
  }

  function input(view: HtmlView): HTMLInputElement {
    const found = view.contentEl.querySelector<HTMLInputElement>(".html-page-viewer__find input");
    assert.ok(found, "the find bar is open");
    return found;
  }

  function press(target: HTMLElement, key: string, shiftKey = false): void {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  }

  async function sourceView(): Promise<{ harness: Harness; view: HtmlView }> {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Notes.html", PAGE);
    button(view, "Source").click();
    return { harness, view };
  }

  it("does not collect text for an empty query", async (t) => {
    const { view } = await sourceView();
    const source = view.contentEl.querySelector(".html-page-viewer__source")!;
    const spy = t.mock.method(source, "querySelectorAll");
    button(view, "Find in page").click();
    assert.equal(spy.mock.callCount(), 0);
    input(view).value = "page";
    press(input(view), "Enter");
    assert.equal(spy.mock.callCount(), 1);
    input(view).value = "";
    press(input(view), "Enter");
    assert.equal(spy.mock.callCount(), 1);
    assert.equal(count(view), "");
  });

  it("finds in the source view, and moves from match to match", async () => {
    const { view } = await sourceView();
    button(view, "Find in page").click();
    const field = input(view);
    field.value = "page";
    press(field, "Enter");
    assert.equal(count(view), "1 of 3");
    assert.deepEqual(highlighted(MATCH_HIGHLIGHT), ["page", "page", "Page"]);
    assert.deepEqual(highlighted(CURRENT_HIGHLIGHT), ["page"]);

    press(field, "Enter");
    assert.equal(count(view), "2 of 3");
    press(field, "Enter");
    press(field, "Enter");
    assert.equal(count(view), "1 of 3", "it wraps around");
    press(field, "Enter", true);
    assert.equal(count(view), "3 of 3");
    assert.deepEqual(highlighted(CURRENT_HIGHLIGHT), ["Page"]);

    field.value = "nothing like it";
    press(field, "Enter");
    assert.equal(count(view), "No matches");
    assert.deepEqual(highlighted(MATCH_HIGHLIGHT), []);
  });

  it("labels its field and every toolbar button, and announces its count", async () => {
    const { view } = await sourceView();
    for (const toolbarButton of view.contentEl.querySelectorAll("button")) {
      // An icon button has a label; a text button is named by its text.
      const name = toolbarButton.getAttribute("aria-label") ?? toolbarButton.textContent ?? "";
      assert.ok(name.trim() !== "", toolbarButton.outerHTML);
      assert.equal(toolbarButton.getAttribute("type"), "button");
    }
    button(view, "Find in page").click();
    assert.equal(input(view).getAttribute("aria-label"), "Find in page");
    const counter = view.contentEl.querySelector(".html-page-viewer__find-count");
    assert.equal(counter?.getAttribute("aria-live"), "polite");
  });

  for (const close of ["Escape", "Close find", "Find in page"]) {
    it(`keeps pending input when closed with ${close}`, async (t) => {
      const { view } = await sourceView();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      document.body.append(view.contentEl);
      try {
        button(view, "Find in page").click();
        input(view).value = "page";
        press(input(view), "Enter");
        input(view).value = "three";
        input(view).dispatchEvent(new window.Event("input"));
        t.mock.timers.tick(149);
        assert.equal(count(view), "1 of 3", "the search remains delayed");
        if (close === "Escape") press(input(view), "Escape");
        else button(view, close).click();
        assert.deepEqual(highlighted(MATCH_HIGHLIGHT), []);
        t.mock.timers.tick(200);
        assert.deepEqual(highlighted(MATCH_HIGHLIGHT), []);
        if (close === "Escape")
          assert.equal(
            document.activeElement,
            view.contentEl.querySelector(".html-page-viewer__source"),
          );
        button(view, "Find in page").click();
        assert.equal(input(view).value, "three");
        assert.equal(count(view), "1 of 1");
      } finally {
        // A failure above leaves the bar and its highlights for the next test.
        const field = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__find input");
        if (field) press(field, "Escape");
        highlights().clear();
        view.contentEl.remove();
      }
    });
  }

  it("searches as the text changes, after a pause", async () => {
    const { view } = await sourceView();
    button(view, "Find in page").click();
    const field = input(view);
    field.value = "three";
    field.dispatchEvent(new window.Event("input"));
    assert.equal(count(view), "");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(count(view), "1 of 1");
    press(field, "Escape");
  });

  it("leaves nothing behind when the bar or the view closes while a search waits", async () => {
    const { view } = await sourceView();
    button(view, "Find in page").click();
    input(view).value = "page";
    input(view).dispatchEvent(new window.Event("input"));
    press(input(view), "Escape");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(highlighted(MATCH_HIGHLIGHT), []);

    button(view, "Find in page").click();
    input(view).value = "page";
    input(view).dispatchEvent(new window.Event("input"));
    // What Obsidian does when it closes the view.
    for (const cleanup of (view as unknown as { cleanups: (() => void)[] }).cleanups) cleanup();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(highlighted(MATCH_HIGHLIGHT), []);
  });

  it("stays on its match when Enter comes before the search it waited for", async () => {
    const { view } = await sourceView();
    button(view, "Find in page").click();
    const field = input(view);
    field.value = "page";
    field.dispatchEvent(new window.Event("input"));
    press(field, "Enter");
    press(field, "Enter");
    assert.equal(count(view), "2 of 3");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(count(view), "2 of 3");
    press(field, "Escape");
  });

  it("keeps text typed just before the view changes, and searches the next file in the tab", async () => {
    const { harness, view } = await sourceView();
    button(view, "Find in page").click();
    input(view).value = "three";
    input(view).dispatchEvent(new window.Event("input"));
    button(view, "Rendered").click();
    button(view, "Source").click();
    assert.equal(input(view).value, "three");
    assert.equal(count(view), "1 of 1");

    input(view).value = "page";
    press(input(view), "Enter");
    harness.open(view, "Other.html", "<p>One page.</p>");
    assert.equal(count(view), "1 of 1");
    assert.deepEqual(highlighted(MATCH_HIGHLIGHT), ["page"]);
    press(input(view), "Escape");
  });

  it("closes with Escape, and leaves no highlight behind", async () => {
    const { view } = await sourceView();
    button(view, "Find in page").click();
    const field = input(view);
    field.value = "page";
    press(field, "Enter");
    press(field, "Escape");
    assert.equal(view.contentEl.querySelector(".html-page-viewer__find"), null);
    assert.deepEqual(highlighted(MATCH_HIGHLIGHT), []);
    assert.deepEqual(highlighted(CURRENT_HIGHLIGHT), []);
  });

  it("opens with Mod+F while the view has focus, and from its command", async () => {
    const { harness, view } = await sourceView();
    const scoped = view as HtmlView & {
      scope: { press(modifiers: string[], key: string): boolean } | null;
    };
    // Obsidian shows the view in its window; an element outside a document takes no focus.
    document.body.append(view.contentEl);
    assert.equal(scoped.scope?.press(["Mod"], "f"), true);
    assert.equal(document.activeElement, input(view));
    press(input(view), "Escape");
    view.contentEl.remove();

    const command = harness.plugin.commands.find((candidate) => candidate.id === "find-in-page");
    assert.ok(command?.checkCallback);
    assert.equal(command.checkCallback(true), false, "not without a viewer in focus");
    harness.app.activeView = view;
    assert.equal(command.checkCallback(true), true);
    command.checkCallback(false);
    assert.ok(input(view));
  });

  it("keeps its text when the view changes between source and rendered", async () => {
    const { view } = await sourceView();
    button(view, "Find in page").click();
    input(view).value = "saved";
    press(input(view), "Enter");
    button(view, "Rendered").click();
    assert.equal(input(view).value, "saved");
    button(view, "Source").click();
    assert.equal(count(view), "1 of 1");
  });

  it("says that it finds only in the source view while scripts are on", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const view = harness.newView();
    harness.open(view, "Notes.html", PAGE);
    await settle();
    button(view, "Find in page").click();
    assert.equal(count(view), "Find works in the source view while scripts are on.");
  });

  // Obsidian takes a moved tab's elements out of the page and inserts them
  // again, in another tab group or window. That collapses every range in
  // them, and a window paints only the ranges in its own highlights.
  describe("after its tab moves (#162)", () => {
    type ResizableView = HtmlView & { onResize(): void };

    /** The view in a tab group of the document, with its find bar on the second of PAGE's three matches. */
    async function finding(mode: string): Promise<{ harness: Harness; view: ResizableView }> {
      // Earlier tests can leave their highlights in the window.
      highlights().clear();
      const harness = await Harness.load();
      const view = harness.newView() as ResizableView;
      const group = document.createElement("div");
      document.body.append(group);
      group.append(view.contentEl);
      harness.open(view, "Notes.html", PAGE);
      button(view, mode).click();
      button(view, "Find in page").click();
      input(view).value = "page";
      press(input(view), "Enter");
      press(input(view), "Enter");
      assert.equal(count(view), "2 of 3");
      return { harness, view };
    }

    /** Counts the find bar's scrolling to a match, which jsdom does not do. */
    function scrollsToMatches(t: TestContext): { readonly count: number } {
      let calls = 0;
      Object.defineProperty(window.Element.prototype, "scrollIntoView", {
        configurable: true,
        value: () => (calls += 1),
      });
      t.after(() => {
        delete (window.Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      });
      return {
        get count() {
          return calls;
        },
      };
    }

    /** Ends a test without leaving its highlights or elements for the next. */
    function close(view: HtmlView): void {
      const field = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__find input");
      if (field) press(field, "Escape");
      highlights().clear();
      const group = view.contentEl.parentElement;
      view.contentEl.remove();
      if (group?.parentElement === document.body) group.remove();
    }

    for (const mode of ["Source", "Split"]) {
      it(`shows them in the ${mode === "Split" ? "split" : "source"} view's source again in another tab group, without scrolling to the current one`, async (t) => {
        const { harness, view } = await finding(mode);
        const scrolls = scrollsToMatches(t);
        try {
          const before = view.contentEl.parentElement!;
          const group = document.createElement("div");
          document.body.append(group);
          group.append(view.contentEl);
          before.remove();
          assert.deepEqual(highlighted(MATCH_HIGHLIGHT), ["", "", ""], "the move collapsed them");

          harness.app.workspace.trigger("layout-change");
          assert.deepEqual(highlighted(MATCH_HIGHLIGHT), ["page", "page", "Page"]);
          assert.deepEqual(highlighted(CURRENT_HIGHLIGHT), ["page"]);
          assert.equal(count(view), "2 of 3");
          assert.equal(scrolls.count, 0);

          // Matches that still show are not searched for again.
          const source = view.contentEl.querySelector(".html-page-viewer__source")!;
          const search = t.mock.method(source, "querySelectorAll");
          harness.app.workspace.trigger("layout-change");
          view.onResize();
          assert.equal(search.mock.callCount(), 0);

          press(input(view), "Enter");
          assert.equal(count(view), "3 of 3");
          assert.deepEqual(highlighted(CURRENT_HIGHLIGHT), ["Page"]);
          assert.equal(scrolls.count, 1, "Enter still scrolls to the next match");
        } finally {
          close(view);
        }
      });
    }

    // Obsidian can take the view out of the page in one script and insert it
    // in the new window in a later one, with a layout change between them,
    // where the view finds the matches again in the old window.
    for (const way of ["at once", "after a layout change on the way"]) {
      it(`shows them in a new window's highlights, and leaves none in the old one's, moved ${way}`, async (t) => {
        const { harness, view } = await finding("Source");
        const scrolls = scrollsToMatches(t);
        // A window of its own, with the highlights that dom.ts gives the tests' window.
        const popout = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
          url: "app://obsidian.md/index.html",
        }).window;
        class Highlight extends Set<Range> {
          priority = 0;
        }
        const registry = new Map<string, Set<Range>>();
        Object.defineProperty(popout, "Highlight", { configurable: true, value: Highlight });
        Object.defineProperty(popout.CSS, "highlights", { configurable: true, value: registry });
        const shown = (name: string): string[] => [...(registry.get(name) ?? [])].map(String);
        const before = view.contentEl.parentElement!;
        try {
          if (way !== "at once") {
            view.contentEl.remove();
            harness.app.workspace.trigger("layout-change");
            assert.deepEqual(highlighted(MATCH_HIGHLIGHT), ["page", "page", "Page"]);
          }
          popout.document.body.append(view.contentEl);
          before.remove();
          assert.deepEqual(shown(MATCH_HIGHLIGHT), []);

          // A new window lays the view out, and resizes it, after the layout change.
          view.onResize();
          assert.deepEqual(shown(MATCH_HIGHLIGHT), ["page", "page", "Page"]);
          assert.deepEqual(shown(CURRENT_HIGHLIGHT), ["page"]);
          assert.deepEqual(highlighted(MATCH_HIGHLIGHT), [], "the old window shows none of them");
          assert.deepEqual(highlighted(CURRENT_HIGHLIGHT), []);
          assert.equal(count(view), "2 of 3");
          assert.equal(scrolls.count, 0);
        } finally {
          close(view);
          popout.close();
        }
      });
    }

    // The bar searches what is typed after a delay, with a timer of the
    // window that shows the bar then. Only that window can clear the timer,
    // and a window that has closed runs none.
    describe("its delay before it searches what was typed (#175)", () => {
      function newWindow(): Window {
        return new JSDOM("<!doctype html><html><head></head><body></body></html>", {
          url: "app://obsidian.md/index.html",
        }).window as unknown as Window;
      }

      it("stays on its match when Enter comes before the search it waited for, in a new window", async () => {
        const { view } = await sourceView();
        // The bar is made in the tests' window.
        button(view, "Find in page").click();
        const popout = newWindow();
        try {
          popout.document.body.append(view.contentEl);
          const field = input(view);
          field.value = "page";
          field.dispatchEvent(new window.Event("input"));
          press(field, "Enter");
          press(field, "Enter");
          assert.equal(count(view), "2 of 3");
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(count(view), "2 of 3");
        } finally {
          view.contentEl.remove();
          popout.close();
        }
      });

      it("stays on its match when Enter comes in a new window before the search it waited for from the window before", async () => {
        const { view } = await sourceView();
        document.body.append(view.contentEl);
        button(view, "Find in page").click();
        const popout = newWindow();
        try {
          const field = input(view);
          field.value = "page";
          field.dispatchEvent(new window.Event("input"));
          popout.document.body.append(view.contentEl);
          press(field, "Enter");
          press(field, "Enter");
          assert.equal(count(view), "2 of 3");
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(count(view), "2 of 3");
        } finally {
          view.contentEl.remove();
          popout.close();
        }
      });

      it("searches what is typed after its tab moved back from a new window, which closed", async () => {
        const { view } = await sourceView();
        const popout = newWindow();
        popout.document.body.append(view.contentEl);
        // The bar is made in the new window.
        button(view, "Find in page").click();
        document.body.append(view.contentEl);
        popout.close();
        try {
          const field = input(view);
          field.value = "page";
          field.dispatchEvent(new window.Event("input"));
          assert.equal(count(view), "", "the search waits");
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(count(view), "1 of 3");
        } finally {
          press(input(view), "Escape");
          highlights().clear();
          view.contentEl.remove();
        }
      });
    });

    it("leaves the rendered page's matches to be found when the frame shows its next document", async () => {
      const harness = await Harness.load();
      const view = harness.newView() as ResizableView;
      harness.open(view, "Notes.html", PAGE);
      const registry = new Map<string, Set<Range>>();
      await loadFrame(view, (page) => {
        class Highlight extends Set<Range> {
          priority = 0;
        }
        const win = page.defaultView!;
        Object.defineProperty(win, "Highlight", { configurable: true, value: Highlight });
        Object.defineProperty(win.CSS, "highlights", { configurable: true, value: registry });
      });
      button(view, "Find in page").click();
      input(view).value = "page";
      press(input(view), "Enter");
      const ranges = [...(registry.get(MATCH_HIGHLIGHT) ?? [])];
      assert.equal(ranges.length, 3);
      // The page's highlights are its frame's window's, not the view's.
      harness.app.workspace.trigger("layout-change");
      view.onResize();
      const after = [...(registry.get(MATCH_HIGHLIGHT) ?? [])];
      assert.equal(after.length, ranges.length);
      after.forEach((range, index) => assert.strictEqual(range, ranges[index], "the same ranges"));
      press(input(view), "Escape");
    });
  });
});
