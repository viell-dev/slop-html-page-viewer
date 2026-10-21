import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURRENT_HIGHLIGHT, findRanges, MATCH_HIGHLIGHT, pageRuns, sourceRuns } from "../src/find";
import { button, Harness, type HtmlView, settle } from "./support/harness";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function texts(html: string, query: string): string[] {
  return findRanges(pageRuns(parse(html)), query).ranges.map((range) => range.toString());
}

describe("finding text in a page", () => {
  it("ignores case, and finds a match across elements within a block", () => {
    assert.deepEqual(texts("<p>Saved <b>Pa</b>ge, saved page</p>", "saved page"), ["Saved Page", "saved page"]);
  });

  it("finds no match from one block into the next", () => {
    assert.deepEqual(texts("<p>first</p><p>second</p><div>third<br>fourth</div>", "firstsecond"), []);
    assert.deepEqual(texts("<div>third<br>fourth</div>", "thirdfourth"), []);
    assert.deepEqual(texts("<ul><li>one</li><li>two</li></ul>", "onetwo"), []);
  });

  it("leaves out text the page does not show", () => {
    const html = "<p>shown</p><script>var shown;</script><style>.shown {}</style><noscript>shown</noscript>";
    assert.deepEqual(texts(html, "shown"), ["shown"]);
  });

  it("finds a query as text, not as a pattern", () => {
    assert.deepEqual(texts("<p>a.b axb (c) [d] \\e /f/ a-b</p>", "a.b"), ["a.b"]);
    assert.deepEqual(texts("<p>(c) [d] \\e /f/ a-b $1</p>", "(c) [d] \\e /f/ a-b $1"), ["(c) [d] \\e /f/ a-b $1"]);
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

  it("finds text in a source view line by line", () => {
    const doc = parse(
      `<div class="src"><div><span class="html-page-viewer__source-code"><span>&lt;</span><span>p</span>&gt;one</span></div>` +
        `<div><span class="html-page-viewer__source-code">two</span></div></div>`,
    );
    const runs = sourceRuns(doc.querySelector(".src")!);
    assert.deepEqual(runs.map((run) => run.text), ["<p>one", "two"]);
    assert.deepEqual(findRanges(runs, "p>o").ranges.map(String), ["p>o"]);
    assert.deepEqual(findRanges(runs, "onetwo").ranges, []);
  });
});

describe("the find bar", () => {
  const PAGE = "<!doctype html>\n<title>Notes</title>\n<p>A saved page about pages.</p>\n<p>Page three.</p>";

  function highlighted(name: string): string[] {
    const registry = (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights;
    return [...(registry.get(name) ?? [])].map(String);
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
    const scoped = view as HtmlView & { scope: { press(modifiers: string[], key: string): boolean } | null };
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
});
