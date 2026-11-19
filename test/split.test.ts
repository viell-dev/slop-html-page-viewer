import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import "./support/dom";
import {
  alignSequences,
  anchorElements,
  lineAtTop,
  lineForPageTop,
  onFirstResize,
  pageTopForLine,
  remeasured,
  ScrollFollower,
  type StartTag,
  syncPoints,
  topOfLine,
} from "../src/split";
import { preparePage, SHADOW_ROOT_MARK } from "../src/document";
import { startTags } from "../src/main";
import { button, Harness, loadFrame, moveFrame } from "./support/harness";

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
    const html =
      "<html><head><title>T</title></head><body><h1>H</h1><p>A <a href=x>link</a></p></body></html>";
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
    const tags = [
      ...head,
      { name: "p", line: 21 },
      { name: "template", line: 29 },
      ...template,
      { name: "h2", line: 50 },
    ];
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

  describe("in shadow roots (#124)", () => {
    /**
     * The page as the frame shows it with scripts off: the view's copy, parsed
     * as Chromium parses it, which jsdom does not. A template that declares a
     * shadow root gives its content to its parent, if that can host one and
     * has none yet, and is left out. Chromium 150 reads only `shadowrootmode`;
     * with `legacy`, as Chromium 114 does, `shadowroot` as well.
     */
    async function framed(source: string, legacy = false): Promise<Document> {
      const context = {
        pageUrl: "app://vault-id/vault/page.html",
        vaultUrl: "app://vault-id/vault/",
        read: () => Promise.resolve(null),
      };
      const { html } = await preparePage(source, context, { openShadowRoots: true });
      const doc = new DOMParser().parseFromString(html, "text/html");
      const attach = (root: ParentNode): void => {
        for (const template of root.querySelectorAll("template")) {
          if (!(template instanceof window.HTMLTemplateElement)) continue;
          const host = template.parentElement;
          const declares =
            template.getAttribute("shadowrootmode") === "open" ||
            (legacy && template.getAttribute("shadowroot") === "open");
          if (!host || host.shadowRoot || !declares) continue;
          try {
            host.attachShadow({ mode: "open" }).append(template.content);
          } catch {
            continue; // An element that cannot host a shadow root.
          }
          template.remove();
          attach(host.shadowRoot!);
        }
      };
      attach(doc);
      return doc;
    }

    async function pairedInFrame(lines: string[], legacy = false): Promise<[string, number][]> {
      const source = lines.join("\n");
      const doc = await framed(source, legacy);
      return anchorElements(doc.body, startTags(source)).map(({ element, line }) => [
        element.id || element.localName,
        line,
      ]);
    }

    it("pairs a shadow root's elements with the lines of the template that declared it", async () => {
      assert.deepEqual(
        await pairedInFrame([
          "<body>",
          "<p>before</p>",
          `<article><template shadowrootmode="open">`,
          "<h2>inside</h2>",
          "<p>inside</p>",
          "</template>",
          "<p>light</p></article>",
          "<p>after</p>",
        ]),
        [
          ["p", 2],
          ["article", 3],
          ["h2", 4],
          ["p", 5],
          ["p", 7],
          ["p", 8],
        ],
      );
    });

    it("pairs those of the body's own shadow root", async () => {
      assert.deepEqual(
        await pairedInFrame([
          "<body>",
          `<template shadowrootmode="open">`,
          `<h1 id="heading">Head</h1>`,
          `<p id="shadow">Shadow</p>`,
          "</template>",
          `<p id="light">Light</p>`,
        ]),
        [
          ["heading", 3],
          ["shadow", 4],
          ["light", 6],
        ],
      );
    });

    it("pairs them where they were declared, after some of the host's own content", async () => {
      assert.deepEqual(
        await pairedInFrame([
          "<body>",
          "<article>",
          `<p id="light-1">Light first</p>`,
          `<p id="light-2">Light second</p>`,
          `<template shadowrootmode="open">`,
          `<p id="shadow-1">Shadow first</p>`,
          `<p id="shadow-2">Shadow second</p>`,
          `<span><template shadowrootmode="open"><p id="nested">Nested</p></template></span>`,
          "</template>",
          `<p id="light-3">Light third</p>`,
          // The host's second declaration stays an ordinary template.
          `<template shadowrootmode="open"><p id="ignored">Ignored</p></template>`,
          `<p id="light-4">Light last</p>`,
          "</article>",
        ]),
        [
          ["article", 2],
          ["light-1", 3],
          ["light-2", 4],
          ["shadow-1", 6],
          ["shadow-2", 7],
          ["span", 8],
          ["light-3", 10],
          ["template", 11],
          ["light-4", 12],
        ],
      );
    });

    it("passes over a comment of the page's own with the mark's text", async () => {
      assert.deepEqual(
        await pairedInFrame([
          "<body>",
          "<article>",
          `<!--${SHADOW_ROOT_MARK}-->`,
          `<p id="light">Light</p>`,
          `<template shadowrootmode="open">`,
          `<p id="shadow">Shadow</p>`,
          "</template>",
          "</article>",
        ]),
        [
          ["article", 2],
          ["light", 4],
          ["shadow", 6],
        ],
      );
    });

    it("passes over the mark of a declaration that stayed a template", async () => {
      const lines = [
        "<body>",
        "<article>",
        `<template shadowroot="open"><p id="legacy">Legacy</p></template>`,
        `<p id="light">Light</p>`,
        `<template shadowrootmode="open">`,
        `<p id="shadow">Shadow</p>`,
        "</template>",
        "</article>",
      ];
      // Chromium 150 leaves the first declaration a template and attaches the second.
      assert.deepEqual(await pairedInFrame(lines), [
        ["article", 2],
        ["template", 3],
        ["light", 4],
        ["shadow", 6],
      ]);
      // Chromium 114 attaches the first and leaves the second a template.
      assert.deepEqual(await pairedInFrame(lines, true), [
        ["article", 2],
        ["legacy", 3],
        ["light", 4],
        ["template", 5],
        ["shadow", 6],
      ]);
    });

    it("takes a shadow root that the copy has not marked to come first", () => {
      const source = [
        "<body>",
        `<article><template shadowrootmode="open">`,
        "<h2>inside</h2>",
        "</template>",
        "<p>light</p></article>",
      ].join("\n");
      const doc = new DOMParser().parseFromString(
        "<body><article><p>light</p></article>",
        "text/html",
      );
      doc.querySelector("article")!.attachShadow({ mode: "open" }).innerHTML = "<h2>inside</h2>";
      assert.deepEqual(
        anchorElements(doc.body, startTags(source)).map(({ element, line }) => [
          element.localName,
          line,
        ]),
        [
          ["article", 2],
          ["h2", 3],
          ["p", 5],
        ],
      );
    });
  });

  it("passes over an SVG element named template, which has no content", () => {
    assert.deepEqual(
      paired(["<body>", "<svg><template><rect/></template></svg>", "<p>after</p>"]),
      [
        ["svg", 2],
        ["p", 3],
      ],
    );
  });

  /** The page's paired elements, as names and lines, for HTML one element to a line. */
  function paired(lines: string[]): [string, number][] {
    const html = lines.join("\n");
    const doc = new DOMParser().parseFromString(html, "text/html");
    return anchorElements(doc.body, startTags(html)).map(({ element, line }) => [
      element.localName,
      line,
    ]);
  }

  it("aligns past the copies that misnested formatting makes", () => {
    const lines = [
      "<body>",
      "<b><p>one</b>two</p>",
      "<h2>three</h2>",
      "<p>four</p>",
      "<p>five</p>",
      "<b>six</b>",
    ];
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

  it("lets a side that the view placed lead, and passes over its report of that", () => {
    const { source, page, following, frame } = follower();
    page.set(600);
    following.placed("page");
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [300]);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [], "the source's report of following is passed over");

    // A user's scroll of the placed side itself leads from where it went.
    page.set(1000);
    following.placed("page");
    page.set(1400);
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [300, 700]);
  });

  it("follows a user's scroll that comes before the report of a side that the view placed (#157)", () => {
    const { source, page, following, frame } = follower();
    page.set(600);
    following.placed("page");
    // In one frame, Chromium reports the source's scroll before the page's.
    source.set(100);
    following.scrolled("source");
    following.scrolled("page");
    frame();
    assert.deepEqual(page.scrolls, [200], "the page follows the user's scroll");
    assert.deepEqual(source.scrolls, [], "the source is not sent back to the page");
  });

  it("passes over a side's report of scrolling that was not the user's", () => {
    const { source, page, following, frame } = follower();
    // As when the find bar's search scrolls the source before the view
    // places a moved page: the source reports it in the frame after.
    source.set(100);
    following.passOver("source");
    page.set(600);
    following.placed("page");
    following.scrolled("source");
    following.scrolled("page");
    frame();
    assert.deepEqual(source.scrolls, [300], "the placed page leads");
    assert.deepEqual(page.scrolls, []);

    source.set(50);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [100], "a user's scroll after that is followed");
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

  it("has the side that led last lead again, once the sides map differently (#165)", () => {
    const source = side(1000);
    const page = side(2000);
    let scale = 2;
    const frames: (() => void)[] = [];
    const following = new ScrollFollower(
      { source, page },
      { source: (top) => top * scale, page: (top) => top / scale },
      (run) => frames.push(run),
    );
    const frame = (): void => {
      for (const run of frames.splice(0)) run();
    };
    following.again();
    assert.equal(frames.length, 0, "nothing before a side has led");

    page.set(600);
    following.placed("page");
    frame();
    assert.deepEqual(source.scrolls, [300]);
    scale = 1.5;
    following.again();
    frame();
    assert.deepEqual(source.scrolls, [300, 400], "the placed page leads again");
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [], "the source's report of following is passed over");

    source.set(300);
    following.scrolled("source");
    frame();
    assert.deepEqual(page.scrolls, [450]);
    scale = 2;
    following.again();
    frame();
    assert.deepEqual(page.scrolls, [450, 600], "the source led last");

    // A side that waits to lead leads once, from where it is.
    page.set(1000);
    following.scrolled("page");
    following.again();
    frame();
    assert.deepEqual(source.scrolls, [300, 400, 500]);
    assert.deepEqual(page.scrolls, [450, 600]);
  });
});

describe("start tags", () => {
  it("lists each start tag with its line, and no end tags, comments, or script contents", () => {
    const html =
      '<!doctype html>\n<p class="a\nb">x</p><!-- <q> -->\n<script>if (a<b) {}</script>\n<IMG\n src="x">';
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
    assert.ok(
      next.contentEl.querySelector(".html-page-viewer__split"),
      "the tab keeps the split view",
    );
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
    assert.equal(
      view.contentEl.querySelector(".html-page-viewer__find-count")?.textContent,
      "1 of 2",
    );
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("finds in its source again after a move, without scrolling to the current match (#157)", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Notes.html", PAGE);
    button(view, "Split").click();
    button(view, "Find in page").click();
    const input = view.contentEl.querySelector<HTMLInputElement>(".html-page-viewer__find input");
    assert.ok(input);
    input.value = "<p";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // jsdom does not scroll; the view brings a match into view with this.
    const revealed: string[] = [];
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        revealed.push(this.textContent ?? "");
      },
    });
    try {
      await loadFrame(view);
      assert.equal(revealed.length, 1, "the first page's document shows the match");
      revealed.length = 0;
      await moveFrame(view);
      assert.deepEqual(revealed, [], "after the move, the source stays where it is");
      assert.equal(
        view.contentEl.querySelector(".html-page-viewer__find-count")?.textContent,
        "1 of 2",
      );
      assert.equal(window.CSS.highlights.get("html-page-viewer-match")?.size, 2);
    } finally {
      delete (window.HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("says that the two sides scroll apart while scripts are on", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const view = harness.newView();
    harness.open(view, "Notes.html", PAGE);
    button(view, "Split").click();
    assert.match(
      view.contentEl.querySelector(".html-page-viewer__security")?.textContent ?? "",
      /scroll apart while scripts are on/,
    );
  });
});
describe("measuring again", () => {
  it("measures again when the size changes, at most once in a while", () => {
    let size = 100;
    let time = 0;
    let measures = 0;
    const value = remeasured(
      () => (measures += 1),
      () => size,
      () => time,
      250,
    );
    assert.equal(value(), 1);
    size = 200;
    time = 100;
    assert.equal(value(), 1, "not yet");
    time = 300;
    assert.equal(value(), 2);
    assert.equal(value(), 2, "not while the size stays");
  });

  it("measures again at once when asked, also before it is due (#165)", () => {
    let size = 100;
    let time = 0;
    let measures = 0;
    const value = remeasured(
      () => (measures += 1),
      () => size,
      () => time,
      250,
    );
    size = 200;
    time = 100;
    value.again();
    assert.equal(value(), 2);
    time = 400;
    assert.equal(value(), 2, "not again for the size that it measured at");
    size = 300;
    assert.equal(value(), 3, "again when due");
  });
});

/**
 * A window of its own, with a stand-in for the ResizeObserver that jsdom
 * does not have, as `resizeObservers` gives it.
 */
function observingWindow() {
  const win = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "app://obsidian.md/index.html",
  }).window as unknown as Window;
  return { win, ...resizeObservers(win) };
}

/**
 * Gives a window a stand-in for the ResizeObserver that jsdom does not have:
 * each observer that the window makes, the elements that it observes, and
 * whether it is still connected. `report` runs the callbacks of those
 * connected, as a window does once its layout has changed sizes.
 */
function resizeObservers(win: Window) {
  const observers: { observed: Element[]; connected: boolean; callback: () => void }[] = [];
  class ResizeObserver {
    private readonly record;
    constructor(callback: () => void) {
      this.record = { observed: [] as Element[], connected: true, callback };
      observers.push(this.record);
    }
    observe(element: Element): void {
      this.record.observed.push(element);
    }
    disconnect(): void {
      this.record.connected = false;
    }
  }
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserver });
  const report = (): void => {
    for (const observer of observers) if (observer.connected) observer.callback();
  };
  return { observers, report };
}

/** Animation frames for a window, which jsdom does not have, that run when `run` says. */
function animationFrames(win: Window): { run(): void } {
  const callbacks: FrameRequestCallback[] = [];
  Object.defineProperty(win, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => callbacks.push(callback),
  });
  return {
    run: () => {
      for (const callback of callbacks.splice(0)) callback(0);
    },
  };
}

/** Gives an element the size that a layout would, which jsdom does not lay out. */
function sized(element: HTMLElement, size: { width: number; height: number }): void {
  Object.defineProperties(element, {
    offsetWidth: { configurable: true, get: () => size.width },
    offsetHeight: { configurable: true, get: () => size.height },
  });
}

describe("the first resize of an element (#165)", () => {
  function observed() {
    const { win, observers, report } = observingWindow();
    const element = win.document.createElement("pre");
    win.document.body.append(element);
    const size = { width: 300, height: 600 };
    sized(element, size);
    return { win, element, size, observers, report };
  }

  it("is noticed once, by an observer of the element's own window, from its size at the start", () => {
    const { win, element, size, observers, report } = observed();
    // The plugin's own window, whose rendering does not report the sizes of
    // another window's elements.
    const own = resizeObservers(globalThis as unknown as Window);
    try {
      let calls = 0;
      onFirstResize(element, () => (calls += 1), new AbortController().signal, 10_000);
      assert.equal(own.observers.length, 0);
      assert.equal(observers.length, 1);
      assert.deepEqual(observers[0].observed, [element]);
      // A window's first report gives the size that the element has then.
      report();
      assert.equal(calls, 0);
      size.height = 560;
      report();
      assert.equal(calls, 1);
      assert.equal(observers[0].connected, false);
      size.width = 320;
      report();
      assert.equal(calls, 1, "only the first change");
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      (win as unknown as { close(): void }).close();
    }
  });

  it("is noticed at the first report when the size has changed since the start", () => {
    const { win, element, size, report } = observed();
    try {
      let calls = 0;
      onFirstResize(element, () => (calls += 1), new AbortController().signal, 10_000);
      size.width = 320;
      report();
      assert.equal(calls, 1);
    } finally {
      (win as unknown as { close(): void }).close();
    }
  });

  it("is no longer watched for once its time has passed, or the signal aborts", async () => {
    const { win, element, size, observers, report } = observed();
    try {
      let calls = 0;
      onFirstResize(element, () => (calls += 1), new AbortController().signal, 20);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(observers[0].connected, false);

      const showing = new AbortController();
      onFirstResize(element, () => (calls += 1), showing.signal, 10_000);
      showing.abort();
      assert.equal(observers[1].connected, false);
      size.height = 560;
      report();
      assert.equal(calls, 0);

      onFirstResize(element, () => (calls += 1), showing.signal, 10_000);
      assert.equal(observers.length, 2, "nothing is observed after the signal aborted");
    } finally {
      (win as unknown as { close(): void }).close();
    }
  });

  it("is not watched for in a window without ResizeObserver", () => {
    const element = document.createElement("pre");
    assert.doesNotThrow(() => onFirstResize(element, () => {}, new AbortController().signal, 20));
  });
});

describe("the split view's page after a move (#157)", () => {
  const LONG = `<!doctype html>\n<title>Long</title>\n${Array.from(
    { length: 10 },
    (_, index) => `<p>Paragraph ${index + 1}</p>`,
  ).join("\n")}`;

  /**
   * Lays a frame's page out as jsdom does not: its paragraphs in a column,
   * each 100 pixels high, with its window scrolled down by 150, into the
   * second paragraph.
   */
  function scrolledDown(page: Document): void {
    const win = page.defaultView!;
    Object.defineProperty(win, "scrollY", { configurable: true, value: 150 });
    Object.defineProperty(win.Element.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element) {
        const index = this.localName === "p" ? [...this.parentElement!.children].indexOf(this) : 0;
        const top = index * 100 - 150;
        return { top, bottom: top + 100, height: 100, width: 100, left: 0, right: 100 };
      },
    });
  }

  /**
   * The split view of LONG, in a window with animation frames, which jsdom
   * does not have and which never run here, so that the view follows its
   * page: its frame shows the page scrolled down, as before a move. `moved`
   * moves the tab, with `away` run while the frame shows no page, and says
   * where the view scrolled the frame's next document to.
   */
  async function splitView() {
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: () => 0,
    });
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Long.html", LONG);
    button(view, "Split").click();
    await loadFrame(view, scrolledDown);
    const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
    return {
      view,
      source,
      moved: async (away?: () => void): Promise<ScrollToOptions[]> => {
        const scrolls: ScrollToOptions[] = [];
        await moveFrame(view, {
          away,
          prepare: (page) => {
            page.defaultView!.scrollTo = ((options: ScrollToOptions) => {
              scrolls.push(options);
            }) as typeof window.scrollTo;
          },
        });
        return scrolls;
      },
    };
  }

  /** The reader turns the wheel over the source, and Chromium reports the scroll. */
  function readerScrolls(source: HTMLElement): void {
    source.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 200 }));
    source.dispatchEvent(new window.Event("scroll"));
  }

  const end = (): void => {
    delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  };

  it("places the frame's next document where the previous one was", async () => {
    try {
      const { moved } = await splitView();
      // Once its text is there, and again when it loads.
      assert.notDeepEqual(await moved(), []);
    } finally {
      end();
    }
  });

  it("leaves it unplaced, for the page to follow the source, after the reader scrolled the source while no page showed", async () => {
    try {
      const { source, moved } = await splitView();
      assert.deepEqual(await moved(() => readerScrolls(source)), []);
    } finally {
      end();
    }
  });

  it("goes on watching the reader when the frame drops a document that it never showed", async () => {
    try {
      const { view, source, moved } = await splitView();
      const scrolls = await moved(() => {
        readerScrolls(source);
        // As when a second move comes before the view shows the page.
        const win = view.contentEl.querySelector("iframe")!.contentDocument!.defaultView!;
        win.dispatchEvent(new win.Event("pagehide"));
      });
      assert.deepEqual(scrolls, []);
    } finally {
      end();
    }
  });
});

describe("the find bar in a page shown again (#157)", () => {
  it("scrolls to the current match in a page that a refresh shows again, which is no move", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(
      view,
      "Notes.html",
      "<!doctype html>\n<title>Notes</title>\n<p>One</p>\n<p>Two</p>",
    );
    button(view, "Find in page").click();
    const input = view.contentEl.querySelector<HTMLInputElement>(".html-page-viewer__find input");
    assert.ok(input);
    input.value = "Two";
    const revealed: string[] = [];
    const watchReveals = (page: Document): void => {
      Object.defineProperty(page.defaultView!.HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value(this: HTMLElement) {
          revealed.push(this.textContent ?? "");
        },
      });
    };
    const page = await loadFrame(view, watchReveals);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    revealed.length = 0;
    // Chromium drops the frame's page, firing pagehide, as emptying the view
    // removes the frame; jsdom's stand-in for the frame's page does not.
    const empty = view.contentEl.empty.bind(view.contentEl);
    view.contentEl.empty = () => {
      page.defaultView!.dispatchEvent(new page.defaultView!.Event("pagehide"));
      empty();
    };
    button(view, "Refresh preview").click();
    await loadFrame(view, watchReveals);
    assert.deepEqual(revealed, ["Two"]);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
});

describe("the split view after its tab moves to a new window (#165)", () => {
  const LONG = `<!doctype html>\n<title>Long</title>\n${Array.from(
    { length: 10 },
    (_, index) => `<p>Paragraph ${index + 1}</p>`,
  ).join("\n")}`;

  /**
   * Lays a frame's page out as jsdom does not: its paragraphs, which are on
   * the source's lines 3 to 12, in a column, each `paragraphs.height` pixels
   * high, in a window 200 pixels high, scrolled from its top by scrollTo,
   * which reports no scroll. `scrolledTo` collects where scrollTo sends it.
   */
  function laidOutPage(
    scrolledTo: number[],
    paragraphs = { height: 100 },
  ): (page: Document) => void {
    return (page) => {
      const win = page.defaultView!;
      let scrollY = 0;
      Object.defineProperty(win, "scrollY", { configurable: true, get: () => scrollY });
      win.scrollTo = ((options: ScrollToOptions) => {
        scrollY = options.top ?? scrollY;
        scrolledTo.push(scrollY);
      }) as typeof win.scrollTo;
      Object.defineProperties(page.documentElement, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 200 },
      });
      Object.defineProperty(win.Element.prototype, "getBoundingClientRect", {
        configurable: true,
        value(this: Element) {
          const index =
            this.localName === "p" ? [...this.parentElement!.children].indexOf(this) : 0;
          const { height } = paragraphs;
          const top = index * height - scrollY;
          return { top, bottom: top + height, height, width: 100, left: 0, right: 100 };
        },
      });
    };
  }

  /**
   * Lays the split view's source out as jsdom does not: its 12 lines from 10
   * pixels down, each `lines.height` pixels high, with its `<pre>` as high as
   * they are, in a source 200 pixels high, which scrollTo scrolls without a
   * report. The reader's scroll reports one.
   */
  function laidOutSource(view: { readonly contentEl: HTMLElement }) {
    const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
    const lines = { height: 20 };
    let top = 0;
    for (const [index, line] of source
      .querySelectorAll<HTMLElement>(".html-page-viewer__source-line")
      .entries())
      Object.defineProperty(line, "offsetTop", {
        configurable: true,
        get: () => 10 + index * lines.height,
      });
    Object.defineProperties(source, {
      scrollTop: { configurable: true, get: () => top },
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTo: {
        configurable: true,
        value: (options: ScrollToOptions) => {
          top = options.top ?? top;
        },
      },
    });
    sized(source.querySelector("pre")!, {
      width: 300,
      get height() {
        return 20 + 12 * lines.height;
      },
    });
    return {
      lines,
      readerScrolls: (to: number): void => {
        top = to;
        source.dispatchEvent(new window.Event("scroll"));
      },
    };
  }

  async function splitView() {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Long.html", LONG);
    button(view, "Split").click();
    const pageScrolls: number[] = [];
    await loadFrame(view, laidOutPage(pageScrolls));
    return { view, pageScrolls, source: laidOutSource(view) };
  }

  it("measures again at the first resize of its source's lines, and the side that led last leads again", async () => {
    const { view, pageScrolls, source } = await splitView();
    const { win: popout, observers, report } = observingWindow();
    const frames = animationFrames(popout);
    const paragraphs = { height: 100 };
    try {
      popout.document.createElement("div").append(view.contentEl);
      await moveFrame(view, { prepare: laidOutPage(pageScrolls, paragraphs) });
      assert.equal(observers.length, 1, "an observer of the new window");
      assert.deepEqual(observers[0].observed, [
        view.contentEl.querySelector(".html-page-viewer__source pre"),
      ]);
      report();

      // Line 8, paragraph 6's, at the source's top.
      source.readerScrolls(150);
      frames.run();
      assert.deepEqual(pageScrolls, [500]);

      // As when Obsidian's styles arrive in the window, and the sides take
      // other widths: 150 pixels are then most of the way through line 8,
      // and the page's paragraphs are shorter.
      source.lines.height = 18;
      paragraphs.height = 80;
      report();
      frames.run();
      assert.deepEqual(pageScrolls, [500, 462]);
      assert.equal(observers[0].connected, false);
    } finally {
      (popout as unknown as { close(): void }).close();
    }
  });

  it("observes nothing for the frame's first document, nor after a move in the same window", async () => {
    const { observers } = resizeObservers(window);
    const frames = animationFrames(window);
    try {
      const { view, pageScrolls, source } = await splitView();
      await moveFrame(view, { prepare: laidOutPage(pageScrolls) });
      source.readerScrolls(150);
      frames.run();
      assert.deepEqual(pageScrolls, [500], "the view follows the source");
      assert.equal(observers.length, 0);
    } finally {
      delete (window as { ResizeObserver?: unknown }).ResizeObserver;
      delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }
  });
});
