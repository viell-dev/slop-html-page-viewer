import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import {
  anchorElements,
  lineAtTop,
  lineForPageTop,
  pageTopForLine,
  type StartTag,
  syncPoints,
  topOfLine,
} from "../src/split";
import { startTags } from "../src/main";
import { button, Harness } from "./support/harness";

function anchors(html: string, tags: StartTag[]): [string, number][] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return anchorElements(doc.body, tags).map(({ element, line }) => [element.localName, line]);
}

describe("pairing a page's elements with their source lines", () => {
  it("pairs each element with its start tag, after the body's", () => {
    const tags = [
      { name: "html", line: 1 },
      { name: "head", line: 2 },
      { name: "title", line: 3 },
      { name: "body", line: 4 },
      { name: "h1", line: 5 },
      { name: "p", line: 6 },
      { name: "a", line: 7 },
    ];
    const html = "<html><head><title>T</title></head><body><h1>H</h1><p>A <a href=x>link</a></p></body></html>";
    assert.deepEqual(anchors(html, tags), [
      ["h1", 5],
      ["p", 6],
      ["a", 7],
    ]);
  });

  it("leaves out elements that the parser adds, and passes over tags it drops", () => {
    // The source has no tbody, and a second, stray html tag.
    const tags = [
      { name: "table", line: 1 },
      { name: "tr", line: 2 },
      { name: "td", line: 3 },
      { name: "html", line: 4 },
      { name: "p", line: 5 },
    ];
    const html = "<table><tr><td>1</td></tr></table><html><p>after</p>";
    assert.deepEqual(anchors(html, tags), [
      ["table", 1],
      ["tr", 2],
      ["td", 3],
      ["p", 5],
    ]);
  });

  it("starts at the first tag without a body tag, and matches SVG's names in any case", () => {
    const tags = [
      { name: "p", line: 1 },
      { name: "svg", line: 2 },
      { name: "lineargradient", line: 3 },
    ];
    const html = "<p>x</p><svg><linearGradient></linearGradient></svg>";
    assert.deepEqual(anchors(html, tags), [
      ["p", 1],
      ["svg", 2],
      ["linearGradient", 3],
    ]);
  });
});

describe("keeping the two sides in step", () => {
  const points = [
    { line: 10, top: 0 },
    { line: 20, top: 500 },
    { line: 40, top: 700 },
  ];

  it("maps a source line to the page's height between the elements around it, and back", () => {
    assert.equal(pageTopForLine(points, 15), 250);
    assert.equal(pageTopForLine(points, 30), 600);
    assert.equal(lineForPageTop(points, 250), 15);
    assert.equal(lineForPageTop(points, 600), 30);
  });

  it("holds to the first and the last element beyond them", () => {
    assert.equal(pageTopForLine(points, 1), 0);
    assert.equal(pageTopForLine(points, 90), 700);
    assert.equal(lineForPageTop(points, 5000), 40);
    assert.equal(pageTopForLine([], 3), null);
  });

  it("finds the source line, with its fraction, at a height of the source view, and back", () => {
    const lineTops = [0, 20, 40, 100, 120];
    assert.equal(lineAtTop(lineTops, 0), 1);
    assert.equal(lineAtTop(lineTops, 30), 2.5);
    assert.equal(lineAtTop(lineTops, 70), 3.5, "a wrapped line is taller");
    assert.equal(topOfLine(lineTops, 3.5), 70);
    assert.equal(topOfLine(lineTops, 1), 0);
    assert.equal(topOfLine(lineTops, 99), 120);
  });

  it("keeps only points in order on both sides", () => {
    const doc = new DOMParser().parseFromString("<p>a</p><p>b</p><p>c</p><p>d</p>", "text/html");
    const [a, b, c, d] = [...doc.querySelectorAll("p")];
    const tops = new Map<Element, number | null>([
      [a, 0],
      [b, null],
      [c, 400],
      [d, 100],
    ]);
    const kept = syncPoints(
      [
        { element: a, line: 1 },
        { element: b, line: 2 },
        { element: c, line: 3 },
        { element: d, line: 4 },
      ],
      (element) => tops.get(element) ?? null,
    );
    assert.deepEqual(kept, [
      { line: 1, top: 0 },
      { line: 3, top: 400 },
    ]);
  });
});

describe("start tags", () => {
  it("lists each start tag with its line, and no end tags, comments, or script contents", () => {
    const html = '<!doctype html>\n<p class="a\nb">x</p><!-- <q> -->\n<script>if (a<b) {}</script>\n<IMG\n src="x">';
    assert.deepEqual(startTags(html), [
      { name: "p", line: 2 },
      { name: "script", line: 4 },
      { name: "img", line: 5 },
    ]);
  });
});

describe("the split view", () => {
  const PAGE = "<!doctype html>\n<title>Notes</title>\n<p>One</p>\n<p>Two</p>";

  it("shows the source beside the page, and the tab keeps it", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Notes.html", PAGE);
    button(view, "Split").click();
    const split = view.contentEl.querySelector(".html-page-viewer__split");
    assert.ok(split?.querySelector(".html-page-viewer__source"));
    assert.ok(split?.querySelector("iframe.html-page-viewer__frame"));
    assert.ok(button(view, "Split").classList.contains("is-active"));
    assert.equal(split?.querySelectorAll(".html-page-viewer__source-line").length, 4);

    const next = harness.newView(view.leaf);
    harness.open(next, "Notes.html", PAGE);
    assert.ok(next.contentEl.querySelector(".html-page-viewer__split"), "the tab keeps the split view");
  });

  it("finds in its source", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Notes.html", PAGE);
    button(view, "Split").click();
    button(view, "Find in page").click();
    const input = view.contentEl.querySelector<HTMLInputElement>(".html-page-viewer__find input");
    assert.ok(input);
    input.value = "<p";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(view.contentEl.querySelector(".html-page-viewer__find-count")?.textContent, "1 of 2");
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("says that the two sides scroll apart while scripts are on", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const view = harness.newView();
    harness.open(view, "Notes.html", PAGE);
    button(view, "Split").click();
    assert.match(view.contentEl.querySelector(".html-page-viewer__security")?.textContent ?? "", /scroll apart while scripts are on/);
  });
});