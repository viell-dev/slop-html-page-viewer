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
    const html = [
      "<p>shown</p><script>var shown;</script><style>.shown {}</style><template>shown</template>",
      "<div hidden>shown</div><details><summary>Open</summary>shown<p>shown</p></details>",
    ].join("");
    assert.deepEqual(texts(html, "shown"), ["shown"]);
    assert.deepEqual(texts("<details><summary>Open</summary>more</details>", "open"), ["Open"]);
    assert.deepEqual(texts("<details open><summary>Open</summary>more</details>", "more"), ["more"]);
  });

  it("finds the text of noscript, which a page with scripts off shows", () => {
    // With scripts off, the parser reads noscript's contents as markup.
    const doc = new DOMParser().parseFromString("<noscript><p>Enable JavaScript</p></noscript>", "text/html");
    assert.deepEqual(findRanges(pageRuns(doc), "javascript").ranges.map(String), ["JavaScript"]);
  });

  it("matches any run of whitespace, as a page shows it, for a space in the query", () => {
    const html = "<p>Saved\n    page, Saved&nbsp;page, Saved\tpage, <b>Saved</b>\n<i>page</i></p>";
    assert.deepEqual(texts(html, "saved page"), ["Saved\n    page", "Saved page", "Saved\tpage", "Saved\npage"]);
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
    assert.deepEqual(runs.map((run) => run.text), ["<p>one", "two"]);
    assert.deepEqual(findRanges(runs, "p>o").ranges.map(String), ["p>o"]);
    assert.deepEqual(findRanges(runs, "onetwo").ranges, []);
  });
});

// jsdom does not load a frame's srcdoc, so finding in the rendered page is tested
// in Obsidian, in test/e2e/specs/find.e2e.ts.
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
