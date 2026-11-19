import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import "./support/dom";
import {
  alignSequences,
  anchorElements,
  lineAtTop,
  lineForPageTop,
  linePlacing,
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
import { keepScrolling } from "../src/scrolling";
import { button, Harness, layOutFrame, loadFrame, moveFrame, settle } from "./support/harness";
import { resizeObservers } from "./support/observers";

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

  it("has a side lead again that led without moving the other side (#165)", () => {
    for (const before of ["already there", "nowhere to go"] as const) {
      const source = side(1000);
      const page = side(2000);
      let follow = (top: number): number | null => (before === "nowhere to go" ? null : top * 2);
      const frames: (() => void)[] = [];
      const following = new ScrollFollower(
        { source, page },
        { source: (top) => follow(top), page: (top) => top / 2 },
        (run) => frames.push(run),
      );
      source.set(100);
      page.set(200);
      following.scrolled("source");
      for (const run of frames.splice(0)) run();
      assert.deepEqual(page.scrolls, [], before);
      assert.equal(following.leading, "source", before);
      follow = (top) => top * 3;
      following.again();
      for (const run of frames.splice(0)) run();
      assert.deepEqual(page.scrolls, [300], before);
    }
  });
});

/**
 * A source in `doc`'s window, laid out as jsdom does not: 12 lines from 10
 * pixels down, each `lines.height` pixels high, in a source 200 pixels high.
 * `scrolledTo` collects where its scrollTo sends it, which reports nothing;
 * `scroll` scrolls it and reports that.
 */
function placedSource(doc: Document = new JSDOM("<!doctype html><body></body>").window.document) {
  const source = doc.createElement("div");
  doc.body.append(source);
  const lines = { height: 20 };
  for (let index = 0; index < 12; index += 1) {
    const line = source.appendChild(doc.createElement("div"));
    line.className = "html-page-viewer__source-line";
    Object.defineProperties(line, {
      offsetTop: { configurable: true, get: () => 10 + index * lines.height },
      offsetHeight: { configurable: true, get: () => lines.height },
    });
  }
  let top = 0;
  let left = 0;
  const scrolledTo: number[] = [];
  Object.defineProperties(source, {
    scrollTop: { configurable: true, get: () => top },
    scrollLeft: { configurable: true, get: () => left },
    clientHeight: { configurable: true, value: 200 },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions) => {
        top = options.top ?? top;
        left = options.left ?? left;
        scrolledTo.push(top);
      },
    },
  });
  return {
    source,
    lines,
    scrolledTo,
    scroll: (to: number, sideways = left): void => {
      top = to;
      left = sideways;
      source.dispatchEvent(new source.ownerDocument.defaultView!.Event("scroll"));
    },
    jump: (to: number): void => {
      top = to;
    },
  };
}

describe("the split view's source's line at its top (#182)", () => {
  it("is the line there, how far into it, and how far sideways, also above the first line", () => {
    const { source, lines, scroll } = placedSource();
    const placing = linePlacing(source);
    for (const [top, place] of [
      [150, { index: 7, into: 0, left: 0 }],
      [155, { index: 7, into: 0.25, left: 0 }],
      [5, { index: 0, into: -0.25, left: 0 }],
      [240, { index: 11, into: 0.5, left: 0 }],
    ] as const) {
      scroll(top);
      assert.deepEqual(placing.measure(), place, `at ${top}`);
      assert.deepEqual(placing.position(place), { top, left: 0 }, `back at ${top}`);
    }
    scroll(155, 30);
    assert.deepEqual(placing.measure(), { index: 7, into: 0.25, left: 30 });
    // The same line, wrapped onto twice as many rows.
    lines.height = 40;
    assert.deepEqual(placing.position({ index: 7, into: 0.25, left: 30 }), { top: 300, left: 30 });
    assert.deepEqual(placing.position({ index: 40, into: 0, left: 0 }), { top: 450, left: 0 });
  });

  it("is the source's top without lines", () => {
    const doc = new JSDOM("<!doctype html><body><div></div></body>").window.document;
    const placing = linePlacing(doc.querySelector("div")!);
    assert.deepEqual(placing.measure(), { index: 0, into: 0, left: 0 });
    assert.equal(placing.position({ index: 0, into: 0, left: 0 }), null);
  });

  it("is measured in the frames of the window that the source is in, also after it moves to another", () => {
    const first = new JSDOM("<!doctype html><body></body>").window;
    const second = new JSDOM("<!doctype html><body></body>").window;
    const firstFrames = animationFrames(first as unknown as Window);
    const secondFrames = animationFrames(second as unknown as Window);
    const { source, lines, scrolledTo, scroll, jump } = placedSource(first.document);
    const kept = keepScrolling(source, linePlacing(source));
    // Line 8, then the source moves to the second window, whose frames run
    // where the first window's no longer do, as after it closed.
    scroll(150);
    second.document.body.append(second.document.adoptNode(source));
    scroll(170);
    secondFrames.run();
    secondFrames.run();
    kept.hold();
    jump(0);
    lines.height = 40;
    kept.back();
    assert.deepEqual(scrolledTo, [330], "line 9, as laid out now");
    // A frame of the first window, from before the move, measures nothing.
    jump(170);
    firstFrames.run();
    firstFrames.run();
    kept.hold();
    jump(0);
    kept.back();
    assert.deepEqual(scrolledTo, [330, 330]);
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

/**
 * How a frame's page is laid out, as jsdom does not: its paragraphs, which
 * are on the source's lines 3 to 12, in a column, each `height` pixels
 * high, in a window 200 pixels high, scrolled down by `scrollY`.
 * `scrolledTo` collects where the window's scrollTo sends it, which
 * reports no scroll; `win` is the window of the page laid out last.
 */
interface PageLayout {
  height: number;
  scrollY: number;
  readonly scrolledTo: number[];
  win: (Window & typeof globalThis) | null;
}

function pageLayout(): PageLayout {
  return { height: 100, scrollY: 0, scrolledTo: [], win: null };
}

/** Lays a frame's page out as `layout` says, from its top. */
function laidOutPage(layout: PageLayout): (page: Document) => void {
  return (page) => {
    const win = page.defaultView!;
    layout.win = win;
    layout.scrollY = 0;
    Object.defineProperty(win, "scrollY", { configurable: true, get: () => layout.scrollY });
    win.scrollTo = ((options: ScrollToOptions) => {
      layout.scrollY = options.top ?? layout.scrollY;
      layout.scrolledTo.push(layout.scrollY);
    }) as typeof win.scrollTo;
    Object.defineProperties(page.documentElement, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    Object.defineProperty(win.Element.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element) {
        const index = this.localName === "p" ? [...this.parentElement!.children].indexOf(this) : 0;
        const { height } = layout;
        const top = index * height - layout.scrollY;
        return { top, bottom: top + height, height, width: 100, left: 0, right: 100 };
      },
    });
    // Each element has its one box, as the view's place of the page reads.
    Object.defineProperty(win.Element.prototype, "getClientRects", {
      configurable: true,
      value(this: Element) {
        return [this.getBoundingClientRect()];
      },
    });
  };
}

/** The reader scrolls the page laid out last, and Chromium reports it. */
function readerScrollsPage(layout: PageLayout, to: number): void {
  layout.scrollY = to;
  layout.win!.dispatchEvent(new layout.win!.Event("scroll"));
}

/**
 * Lays the split view's source out as jsdom does not: its 12 lines from 10
 * pixels down, each `lines.height` pixels high, with its `<pre>` as high as
 * they are, in a source 200 pixels high. `scrolledTo` collects where its
 * scrollTo sends it, which reports no scroll. The reader's scroll reports
 * one; `jump` scrolls it without a report, as Chromium's scroll anchoring
 * does when its content moves.
 */
function laidOutSource(view: { readonly contentEl: HTMLElement }) {
  const source = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source")!;
  const lines = { height: 20 };
  const scrolledTo: number[] = [];
  let top = 0;
  for (const [index, line] of source
    .querySelectorAll<HTMLElement>(".html-page-viewer__source-line")
    .entries())
    Object.defineProperties(line, {
      offsetTop: { configurable: true, get: () => 10 + index * lines.height },
      offsetHeight: { configurable: true, get: () => lines.height },
    });
  Object.defineProperties(source, {
    scrollTop: { configurable: true, get: () => top },
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions) => {
        top = options.top ?? top;
        scrolledTo.push(top);
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
    scrolledTo,
    readerScrolls: (to: number): void => {
      top = to;
      source.dispatchEvent(new window.Event("scroll"));
    },
    jump: (to: number): void => {
      top = to;
    },
  };
}

describe("the split view after its tab moves to a new window (#165)", () => {
  const LONG = `<!doctype html>\n<title>Long</title>\n${Array.from(
    { length: 10 },
    (_, index) => `<p>Paragraph ${index + 1}</p>`,
  ).join("\n")}`;

  async function splitView() {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Long.html", LONG);
    button(view, "Split").click();
    const page = pageLayout();
    await loadFrame(view, laidOutPage(page));
    return { view, page, source: laidOutSource(view) };
  }

  /**
   * The split view moved to a new window, with that window's observers and
   * animation frames. Its timers of a second or more wait in `timers`, for
   * the test to run, and its others run as usual.
   */
  async function movedToNewWindow() {
    const { view, page, source } = await splitView();
    const { win: popout, observers, report } = observingWindow();
    const frames = animationFrames(popout);
    const timers: { delay: number; run: () => void }[] = [];
    const setTimer = popout.setTimeout.bind(popout);
    popout.setTimeout = ((run: () => void, delay = 0) => {
      if (delay < 1000) return setTimer(run, delay);
      timers.push({ delay, run });
      return 0;
    }) as typeof popout.setTimeout;
    popout.document.createElement("div").append(view.contentEl);
    await moveFrame(view, { prepare: laidOutPage(page) });
    return {
      view,
      page,
      source,
      observers,
      report,
      frames,
      timers,
      close: () => (popout as unknown as { close(): void }).close(),
    };
  }

  it("keeps the line that the source led from at the first resize of its lines, and the page follows it", async () => {
    const moved = await movedToNewWindow();
    const { view, page, source, observers, report, frames } = moved;
    try {
      // The other observes the frame, for when Obsidian hides the tab (#178).
      const pre = view.contentEl.querySelector(".html-page-viewer__source pre")!;
      const lines = observers.filter((observer) => observer.observed.includes(pre));
      assert.equal(lines.length, 1, "an observer of the source's lines in the new window");
      assert.deepEqual(lines[0].observed, [pre]);
      report();

      // Line 8, paragraph 6's, at the source's top.
      source.readerScrolls(150);
      frames.run();
      assert.deepEqual(page.scrolledTo, [500]);

      // As when Obsidian's styles arrive in the window, and the sides take
      // other widths: line 8 is then at 136 pixels, and the page's
      // paragraphs are shorter.
      source.lines.height = 18;
      page.height = 80;
      report();
      assert.deepEqual(source.scrolledTo, [136], "back at line 8");
      frames.run();
      assert.deepEqual(page.scrolledTo, [500, 400], "the page follows to paragraph 6");
      assert.equal(lines[0].connected, false);
    } finally {
      moved.close();
    }
  });

  it("has the page lead again at the first resize of the source's lines when the page led last", async () => {
    const moved = await movedToNewWindow();
    const { page, source, report, frames } = moved;
    try {
      report();
      // Paragraph 6, on line 8, at the page's top.
      readerScrollsPage(page, 500);
      frames.run();
      assert.deepEqual(source.scrolledTo, [150]);
      source.lines.height = 18;
      report();
      frames.run();
      assert.deepEqual(source.scrolledTo, [150, 136], "the source follows to line 8 again");
      assert.deepEqual(page.scrolledTo, []);
    } finally {
      moved.close();
    }
  });

  it("has the source lead from where it is when it moved since it led, as scroll anchoring moves it", async () => {
    const moved = await movedToNewWindow();
    const { page, source, report, frames } = moved;
    try {
      report();
      source.readerScrolls(150);
      frames.run();
      assert.deepEqual(page.scrolledTo, [500]);
      // Chromium keeps line 8 at the source's top as the lines move.
      source.lines.height = 18;
      source.jump(136);
      report();
      frames.run();
      assert.deepEqual(source.scrolledTo, []);
      assert.deepEqual(page.scrolledTo, [500], "the page is at line 8's paragraph already");
    } finally {
      moved.close();
    }
  });

  it("leaves the page where the reader scrolled it last, also when the source did not have to move", async () => {
    const moved = await movedToNewWindow();
    const { page, source, report, frames } = moved;
    try {
      report();
      source.readerScrolls(150);
      frames.run();
      assert.deepEqual(page.scrolledTo, [500]);
      // Less than a pixel of the source away from where it is.
      readerScrollsPage(page, 502);
      frames.run();
      assert.deepEqual(source.scrolledTo, []);
      source.lines.height = 18;
      report();
      frames.run();
      assert.deepEqual(source.scrolledTo, [136]);
      assert.deepEqual(page.scrolledTo, [500], "the page stays at 502");
    } finally {
      moved.close();
    }
  });

  it("leaves a lead that waits to its frame, as of the reader's scroll of the page", async () => {
    const moved = await movedToNewWindow();
    const { page, source, report, frames } = moved;
    try {
      report();
      source.readerScrolls(150);
      frames.run();
      assert.deepEqual(page.scrolledTo, [500]);
      // Paragraph 7, on line 9, before the frame in which the source follows.
      readerScrollsPage(page, 600);
      source.lines.height = 18;
      report();
      frames.run();
      assert.deepEqual(source.scrolledTo, [154], "line 9, by the lines' new tops");
      assert.deepEqual(page.scrolledTo, [500]);
    } finally {
      moved.close();
    }
  });

  it("stops observing two seconds after it shows the page, or when the frame drops the page", async () => {
    let moved = await movedToNewWindow();
    try {
      const { observers, timers } = moved;
      await settle();
      assert.equal(observers[0].connected, true);
      assert.deepEqual(
        timers.map((timer) => timer.delay),
        [2000],
      );
      timers[0].run();
      assert.equal(observers[0].connected, false);
    } finally {
      moved.close();
    }

    moved = await movedToNewWindow();
    try {
      const { view, observers } = moved;
      const win = view.contentEl.querySelector("iframe")!.contentDocument!.defaultView!;
      win.dispatchEvent(new win.Event("pagehide"));
      assert.equal(observers[0].connected, false);
      // Nor does the view observe the frame for the page that it dropped (#178).
      assert.deepEqual(
        observers.map((observer) => observer.connected),
        observers.map(() => false),
      );
    } finally {
      moved.close();
    }
  });

  it("observes nothing for the frame's first document, nor after a move in the same window", async () => {
    const { observers } = resizeObservers(window);
    const frames = animationFrames(window);
    try {
      const { view, page, source } = await splitView();
      await moveFrame(view, { prepare: laidOutPage(page) });
      source.readerScrolls(150);
      frames.run();
      assert.deepEqual(page.scrolledTo, [500], "the view follows the source");
      const pre = view.contentEl.querySelector(".html-page-viewer__source pre")!;
      assert.equal(observers.filter((observer) => observer.observed.includes(pre)).length, 0);
    } finally {
      delete (window as { ResizeObserver?: unknown }).ResizeObserver;
      delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }
  });
});

describe("the view's page in a tab that Obsidian hides and shows again (#178)", () => {
  const LONG = `<!doctype html>\n<title>Long</title>\n${Array.from(
    { length: 10 },
    (_, index) => `<p>Paragraph ${index + 1}</p>`,
  ).join("\n")}`;

  /**
   * The view of LONG in Obsidian's main window, which holds it, with the
   * window's observers and animation frames, its frame's page laid out by
   * `laidOutPage`, and in the split view its source by `laidOutSource`. The
   * frame is 200 pixels high. `reportSource` has Chromium report where the
   * source is scrolled to, as it does in its next frame.
   *
   * `hide` does what Chromium does when Obsidian hides the tab with
   * `display: none`: the frame has no size, its page goes to its start and
   * reports that, the source reads as at its start, and then the window's
   * observers report. `show` lays the frame out again and has the observers
   * report. Given `sourceAt`, Chromium lays the source out there, and
   * reports it before the frame's observer reports, with `reportsFirst`, or
   * in the frame after.
   */
  async function hiddenView(mode: "Rendered" | "Split") {
    const { report } = resizeObservers(window);
    const frames = animationFrames(window);
    const harness = await Harness.load();
    const view = harness.newView();
    document.body.append(view.contentEl);
    harness.open(view, "Long.html", LONG);
    // The source is laid out before the page shows, so that the split view
    // measures its lines.
    const source = mode === "Split" ? (button(view, "Split").click(), laidOutSource(view)) : null;
    const page = pageLayout();
    await loadFrame(view, laidOutPage(page));
    const iframe = view.contentEl.querySelector("iframe")!;
    const sourceEl = view.contentEl.querySelector<HTMLElement>(".html-page-viewer__source");
    layOutFrame(iframe, 200);
    // A window's first report gives the sizes that the elements have then.
    report();
    const reportSource = (): void => {
      sourceEl?.dispatchEvent(new window.Event("scroll"));
    };
    return {
      view,
      page,
      source,
      sourceEl,
      frames,
      reportSource,
      hide: (): void => {
        layOutFrame(iframe, 0);
        page.scrollY = 0;
        page.win!.dispatchEvent(new page.win!.Event("scroll"));
        source?.jump(0);
        report();
      },
      show: ({
        sourceAt,
        reportsFirst = false,
      }: { sourceAt?: number; reportsFirst?: boolean } = {}) => {
        layOutFrame(iframe, 200);
        if (sourceAt !== undefined) source?.jump(sourceAt);
        if (reportsFirst) reportSource();
        report();
        if (!reportsFirst) reportSource();
      },
      /**
       * Moves the hidden tab, as to a new window: Obsidian takes the view out
       * of the page, and the frame drops its document. The view shows in its
       * new place, where Chromium shows the source from its start until the
       * view puts it back at Obsidian's layout change (#135), and the frame
       * loads its next document.
       */
      moveHidden: async (): Promise<void> => {
        view.contentEl.remove();
        await moveFrame(view, {
          away: () => {
            document.body.append(view.contentEl);
            layOutFrame(iframe, 200);
            source?.jump(0);
            harness.app.workspace.trigger("layout-change");
          },
          prepare: laidOutPage(page),
        });
        report();
      },
      end: (): void => {
        view.contentEl.remove();
        delete (window as { ResizeObserver?: unknown }).ResizeObserver;
        delete (window as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      },
    };
  }

  it("shows the rendered view's page where it was", async () => {
    const shown = await hiddenView("Rendered");
    try {
      const { page, hide, show } = shown;
      readerScrollsPage(page, 500);
      hide();
      assert.deepEqual(page.scrolledTo, []);
      show();
      assert.deepEqual(page.scrolledTo, [500]);
    } finally {
      shown.end();
    }
  });

  it("shows the page where the find bar scrolled it, also before Chromium reported that scroll", async () => {
    const shown = await hiddenView("Rendered");
    try {
      const { view, page, hide, show } = shown;
      readerScrollsPage(page, 500);
      // The find bar scrolls the page to paragraph 3's match in one step,
      // which Chromium would report in its next frame.
      Object.defineProperty(page.win!.Element.prototype, "scrollIntoView", {
        configurable: true,
        value: () => {
          page.scrollY = 200;
        },
      });
      button(view, "Find in page").click();
      const field = view.contentEl.querySelector<HTMLInputElement>(
        ".html-page-viewer__find input",
      )!;
      field.value = "Paragraph 3";
      field.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      assert.equal(page.scrollY, 200);
      hide();
      show();
      assert.deepEqual(page.scrolledTo, [200]);
      field.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    } finally {
      shown.end();
    }
  });

  // Chromium lays a split view's source whose lines wrap out some lines from
  // where it was, and reports that during the task that shows the tab, or in
  // the frame after the frame's observer reports.
  for (const reportsFirst of [true, false]) {
    it(`puts the split view's source back where Chromium lays it out elsewhere, ${reportsFirst ? "before" : "after"} the frame's observer reports, and leads neither side with it`, async () => {
      const shown = await hiddenView("Split");
      try {
        const { page, source, frames, reportSource, hide, show } = shown;
        // Paragraph 6, on line 8, at the page's top; the source follows.
        readerScrollsPage(page, 500);
        frames.run();
        reportSource();
        assert.deepEqual(source!.scrolledTo, [150]);
        hide();
        frames.run();
        assert.deepEqual(source!.scrolledTo, [150], "the source does not follow the hidden page");
        // Line 10.
        show({ sourceAt: 190, reportsFirst });
        frames.run();
        assert.deepEqual(source!.scrolledTo, [150, 150], "the source goes back to line 8");
        assert.deepEqual(page.scrolledTo, [500], "and the page to paragraph 6");
        frames.run();
        assert.deepEqual(source!.scrolledTo, [150, 150]);
        assert.deepEqual(page.scrolledTo, [500]);
      } finally {
        shown.end();
      }
    });
  }

  for (const reportsFirst of [true, false]) {
    it(`puts a source that led back where it was, where Chromium lays it out elsewhere, ${reportsFirst ? "before" : "after"} the frame's observer reports, and the page stays`, async () => {
      const shown = await hiddenView("Split");
      try {
        const { page, source, frames, hide, show } = shown;
        source!.readerScrolls(150);
        frames.run();
        page.win!.dispatchEvent(new page.win!.Event("scroll"));
        assert.deepEqual(page.scrolledTo, [500]);
        hide();
        show({ sourceAt: 190, reportsFirst });
        frames.run();
        frames.run();
        assert.deepEqual(source!.scrolledTo, [150], "back at line 8");
        assert.deepEqual(page.scrolledTo, [500, 500], "the page goes back to paragraph 6");
      } finally {
        shown.end();
      }
    });
  }

  // As where the pane changed width while the tab was hidden: the page's
  // paragraphs and the source's lines wrap onto more lines (#182).
  it("shows the page's paragraph and the source's line that were at their tops, where both wrap otherwise after the tab was hidden (#182)", async () => {
    const shown = await hiddenView("Split");
    try {
      const { page, source, frames, hide, show } = shown;
      // Line 8, paragraph 6's, at the source's top; the page follows.
      source!.readerScrolls(150);
      frames.run();
      page.win!.dispatchEvent(new page.win!.Event("scroll"));
      assert.deepEqual(page.scrolledTo, [500]);
      // The source measures its line once a frame passes without a report.
      frames.run();
      hide();
      page.height = 80;
      source!.lines.height = 40;
      show({ sourceAt: 150 });
      frames.run();
      assert.deepEqual(page.scrolledTo, [500, 400], "the page at paragraph 6");
      assert.deepEqual(source!.scrolledTo, [290], "the source at line 8");
      frames.run();
      assert.deepEqual(page.scrolledTo, [500, 400], "and the sides are in step");
    } finally {
      shown.end();
    }
  });

  // The source's line is measured only once its scrolling settles; before
  // that, the source goes back as far down as it was, and the side that led
  // last puts the sides in step once.
  for (const reportsFirst of [true, false]) {
    it(`has the page that led last lead the sides in step once, where the source's line was not measured before the tab hid, ${reportsFirst ? "with the source's report first" : "with the frame's observer first"}`, async () => {
      const shown = await hiddenView("Split");
      try {
        const { page, source, frames, reportSource, hide, show } = shown;
        readerScrollsPage(page, 500);
        frames.run();
        reportSource();
        hide();
        page.height = 80;
        source!.lines.height = 40;
        show({ sourceAt: 190, reportsFirst });
        assert.deepEqual(page.scrolledTo, [400], "the page at paragraph 6");
        assert.deepEqual(source!.scrolledTo, [150, 150], "the source as far down as it was");
        frames.run();
        assert.deepEqual(source!.scrolledTo, [150, 150, 290], "and then at line 8");
        reportSource();
        frames.run();
        assert.deepEqual(source!.scrolledTo, [150, 150, 290], "once");
        assert.deepEqual(page.scrolledTo, [400]);
      } finally {
        shown.end();
      }
    });
  }

  it("goes back as far down as the reader last scrolled the source, where they did so after its line was measured", async () => {
    const shown = await hiddenView("Split");
    try {
      const { page, source, frames, hide, show } = shown;
      source!.readerScrolls(150);
      frames.run();
      page.win!.dispatchEvent(new page.win!.Event("scroll"));
      frames.run();
      // Line 10, and the tab hides before Chromium's next frame.
      source!.readerScrolls(190);
      hide();
      source!.lines.height = 40;
      show({ sourceAt: 190 });
      assert.deepEqual(source!.scrolledTo, [], "not to line 8");
    } finally {
      shown.end();
    }
  });

  it("follows the reader's scroll of the split view's source as the tab shows again", async () => {
    const shown = await hiddenView("Split");
    try {
      const { page, source, sourceEl, frames, reportSource, hide, show } = shown;
      readerScrollsPage(page, 500);
      frames.run();
      reportSource();
      hide();
      // The watch of the reader counts input from the task after the hiding.
      await settle();
      // Line 10, as the reader's wheel scrolls the source before the frame's
      // observer reports.
      sourceEl!.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 200 }));
      show({ sourceAt: 190, reportsFirst: true });
      frames.run();
      assert.deepEqual(source!.scrolledTo, [150], "the source is not sent back");
      assert.deepEqual(page.scrolledTo, [500, 700], "the page follows it to paragraph 8");
      // The source's place is the reader's again: their next scroll, to line
      // 11, stays at the next switch.
      page.win!.dispatchEvent(new page.win!.Event("scroll"));
      source!.readerScrolls(210);
      frames.run();
      page.win!.dispatchEvent(new page.win!.Event("scroll"));
      hide();
      show({ sourceAt: 210 });
      frames.run();
      assert.deepEqual(source!.scrolledTo, [150], "the source stays at line 11");
      assert.deepEqual(page.scrolledTo, [500, 700, 800, 800], "and the page at paragraph 9");
    } finally {
      shown.end();
    }
  });

  it("takes the reader's scroll of the split view's source for its place between two switches", async () => {
    const shown = await hiddenView("Split");
    try {
      const { page, source, frames, reportSource, hide, show } = shown;
      readerScrollsPage(page, 500);
      frames.run();
      reportSource();
      hide();
      show({ sourceAt: 150 });
      frames.run();
      // Line 10, and the page follows to paragraph 8.
      source!.readerScrolls(190);
      frames.run();
      page.win!.dispatchEvent(new page.win!.Event("scroll"));
      hide();
      show({ sourceAt: 190 });
      frames.run();
      assert.deepEqual(source!.scrolledTo, [150], "the source stays at line 10");
      assert.deepEqual(page.scrolledTo, [500, 700, 700], "and the page at paragraph 8");
    } finally {
      shown.end();
    }
  });

  it("takes the reader's scroll of the split view's source for its place after the hidden tab moved", async () => {
    const shown = await hiddenView("Split");
    try {
      const { page, source, frames, reportSource, hide, show, moveHidden } = shown;
      readerScrollsPage(page, 500);
      frames.run();
      reportSource();
      hide();
      // The frame drops its document while the tab is hidden, and no showing
      // of it comes.
      await moveHidden();
      reportSource();
      assert.deepEqual(source!.scrolledTo, [150, 150], "the source is back at line 8");
      // Line 10, in the tab's new place.
      source!.readerScrolls(190);
      frames.run();
      page.win!.dispatchEvent(new page.win!.Event("scroll"));
      hide();
      show({ sourceAt: 190 });
      frames.run();
      assert.deepEqual(source!.scrolledTo, [150, 150], "the source stays at line 10");
    } finally {
      shown.end();
    }
  });

  for (const mode of ["Rendered", "Split"] as const) {
    it(`shows the ${mode.toLowerCase()} view's page where it was after its hidden tab moved (#186)`, async () => {
      const shown = await hiddenView(mode);
      try {
        const { page, frames, hide, moveHidden } = shown;
        // Paragraph 6 at the page's top.
        readerScrollsPage(page, 500);
        frames.run();
        hide();
        // Chromium has scrolled the hidden page to its start, and the frame
        // drops it: its next document shows paragraph 6 again, once its text
        // is there and again when it loads.
        await moveHidden();
        assert.deepEqual(page.scrolledTo, [500, 500]);
      } finally {
        shown.end();
      }
    });
  }

  it("shows the page where it was when its tab moved while it showed, after it was hidden and shown again", async () => {
    const shown = await hiddenView("Rendered");
    try {
      const { view, page, hide, show } = shown;
      readerScrollsPage(page, 500);
      hide();
      show();
      // Paragraph 8, which Chromium has yet to report when the tab moves.
      page.scrollY = 700;
      page.scrolledTo.length = 0;
      await moveFrame(view, { prepare: laidOutPage(page) });
      assert.deepEqual(page.scrolledTo, [700, 700]);
    } finally {
      shown.end();
    }
  });

  it("shows the page at its top after its hidden tab moved, where it was at its top", async () => {
    const shown = await hiddenView("Rendered");
    try {
      const { page, hide, moveHidden } = shown;
      readerScrollsPage(page, 500);
      readerScrollsPage(page, 0);
      hide();
      await moveHidden();
      assert.deepEqual(page.scrolledTo, []);
    } finally {
      shown.end();
    }
  });

  it("follows the reader's scroll of the split view's source that Chromium reports with the page's going back (#157)", async () => {
    const shown = await hiddenView("Split");
    try {
      const { page, source, frames, reportSource, hide, show } = shown;
      readerScrollsPage(page, 500);
      frames.run();
      reportSource();
      hide();
      show({ sourceAt: 150 });
      assert.deepEqual(page.scrolledTo, [500]);
      // The reader scrolls the source to line 10 before Chromium's next
      // frame, which reports the source's scroll, in Obsidian's window, before
      // the page's going back.
      source!.readerScrolls(190);
      page.win!.dispatchEvent(new page.win!.Event("scroll"));
      frames.run();
      assert.deepEqual(page.scrolledTo, [500, 700], "the page follows to paragraph 8");
      assert.deepEqual(source!.scrolledTo, [150], "the source is not sent back");
    } finally {
      shown.end();
    }
  });
});
