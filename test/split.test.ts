import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import {
  alignSequences,
  anchorElements,
  lineAtTop,
  lineForPageTop,
  pageTopForLine,
  remeasured,
  ScrollFollower,
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

  it("keeps its place after a long head without a body tag, and after a template's contents", () => {
    const head = Array.from({ length: 20 }, (_, index) => ({ name: "meta", line: index + 1 }));
    const template = Array.from({ length: 20 }, (_, index) => ({ name: "li", line: 30 + index }));
    const tags = [...head, { name: "p", line: 21 }, { name: "template", line: 29 }, ...template, { name: "h2", line: 50 }];
    const html = `${"<meta>".repeat(20)}<p>first</p><template>${"<li>x</li>".repeat(20)}</template><h2>after</h2>`;
    assert.deepEqual(
      anchors(html, tags).filter(([name]) => name !== "li"),
      [
        ["p", 21],
        ["template", 29],
        ["h2", 50],
      ],
    );
  });

  /** The page's paired elements, as names and lines, for HTML one element to a line. */
  function paired(lines: string[]): [string, number][] {
    const html = lines.join("\n");
    const doc = new DOMParser().parseFromString(html, "text/html");
    return anchorElements(doc.body, startTags(html)).map(({ element, line }) => [element.localName, line]);
  }

  it("aligns past the copies that misnested formatting makes", () => {
    const lines = ["<body>", "<b><p>one</b>two</p>", "<h2>three</h2>", "<p>four</p>", "<p>five</p>", "<b>six</b>"];
    assert.deepEqual(paired(lines), [
      ["b", 2],
      ["h2", 3],
      ["p", 4],
      ["p", 5],
      ["b", 6],
    ]);
  });

  it("aligns past a paragraph that a stray end tag makes, and past tags the parser drops", () => {
    const lines = [
      "<body>",
      "<div>a</p></div>",
      "<p>b</p>",
      `<select>${"<div>dropped</div>".repeat(20)}</select>`,
      "<h2>c</h2>",
      "<p>d</p>",
      "<image src=x.png>",
    ];
    assert.deepEqual(paired(lines), [
      ["div", 2],
      ["p", 3],
      ["select", 4],
      ["h2", 5],
      ["p", 6],
      ["img", 7],
    ]);
  });

  it("finds the longest agreement of two sequences, or gives up beyond its limit", () => {
    assert.deepEqual(alignSequences(["a", "x", "b", "c"], ["a", "b", "y", "c"], 10), [
      [0, 0],
      [2, 1],
      [3, 3],
    ]);
    assert.deepEqual(alignSequences([], ["a"], 10), []);
    assert.equal(alignSequences(["a", "b", "c"], ["x", "y", "z"], 4), null);
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

  function pointsFor(tops: (number | null)[], ends?: { lines: number; height: number }) {
    const doc = new DOMParser().parseFromString("<p></p>".repeat(tops.length), "text/html");
    const elements: Element[] = [...doc.querySelectorAll("p")];
    const anchors = elements.map((element, index) => ({ element, line: index + 1 }));
    return syncPoints(anchors, (element) => tops[elements.indexOf(element)], ends);
  }

  it("leaves out an element shown out of order, and keeps the ones after it", () => {
    // The second element is positioned far down the page, as a fixed header is when measured scrolled.
    assert.deepEqual(pointsFor([0, 3000, 100, null, 200, 4000]), [
      { line: 1, top: 0 },
      { line: 3, top: 100 },
      { line: 5, top: 200 },
      { line: 6, top: 4000 },
    ]);
  });

  it("adds both sides' ends as points", () => {
    assert.deepEqual(pointsFor([null, 50, 80], { lines: 10, height: 900 }), [
      { line: 1, top: 0 },
      { line: 2, top: 50 },
      { line: 3, top: 80 },
      { line: 10, top: 900 },
    ]);
    assert.deepEqual(pointsFor([], { lines: 4, height: 300 }), [
      { line: 1, top: 0 },
      { line: 4, top: 300 },
    ]);
  });
});

describe("following a scrolled side", () => {
  /** A side that scrolls at once, or, like a page that snaps, to the nearest multiple of `snap`. */
  function side(furthest: number, snap = 1) {
    let position = 0;
    const scrolls: number[] = [];
    return {
      scrolls,
      position: () => position,
      furthest: () => furthest,
      scrollTo: (to: number) => {
        position = Math.round(to / snap) * snap;
        scrolls.push(position);
      },
      /** The user scrolls it. */
      set: (to: number) => {
        position = to;
      },
    };
  }

  function follower(source = side(1000), page = side(2000)) {
    const frames: (() => void)[] = [];
    const following = new ScrollFollower(
      { source, page },
      { source: (top) => top * 2, page: (top) => top / 2 },
      (run) => frames.push(run),
    );
    const frame = (): void => {
      for (const run of frames.splice(0)) run();
    };
    return { source, page, following, frame };
  }

  it("moves the other side once a frame, and passes over the scroll that this causes", () => {
    const { source, page, following, frame } = follower();
    source.set(100);
    following.scrolled("source");
    source.set(150);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [300], "once for the frame, from the latest position");
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [], "the page's own report of it is passed over");

    page.set(600);
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [300]);
  });

  it("keeps the other side within what it can scroll to, and leaves it when it is there", () => {
    const { source, page, following, frame } = follower(side(1000), side(500));
    source.set(400);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [500]);
    following.scrolled("page");
    source.set(450);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [500], "already as far as it goes");
    page.set(100);
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [50], "a user's scroll after that is followed");
  });

  it("follows a user's scroll that comes in the same report as the one it caused", () => {
    const { source, page, following, frame } = follower();
    source.set(100);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [200]);
    // The user scrolls the page before it reports the move to 200; one report says where it is now.
    page.set(700);
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [350]);
  });

  it("passes over one report of a page that does not land where it was sent", () => {
    const { source, page, following, frame } = follower(side(1000), side(2000, 64));
    source.set(110);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [192]);
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [], "the snapped position is not taken for a user's scroll");
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
describe("measuring again", () => {
  it("measures again when the size changes, at most once in a while", () => {
    let size = 100;
    let time = 0;
    let measures = 0;
    const value = remeasured(() => (measures += 1), () => size, () => time, 250);
    assert.equal(value(), 1);
    size = 200;
    time = 100;
    assert.equal(value(), 1, "not yet");
    time = 300;
    assert.equal(value(), 2);
    assert.equal(value(), 2, "not while the size stays");
  });
});