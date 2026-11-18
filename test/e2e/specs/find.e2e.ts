import { browser, expect } from "@wdio/globals";
import { type Color, type Pixels, decodePng } from "../support/pixels.ts";
import {
  ACTIVE,
  clickToolbarButton,
  framePixels,
  openInActiveTab,
  saveScreenshot,
  waitForPage,
} from "../support/viewer.ts";

// The colour of the current match in a page (FIND_STYLE in src/find.ts).
const CURRENT: Color = [255, 150, 50];

const findInput = (): ReturnType<typeof browser.$> =>
  browser.$(`${ACTIVE} .html-page-viewer__find input`);

async function findCount(): Promise<string> {
  return browser.$(`${ACTIVE} .html-page-viewer__find-count`).getText();
}

/** Types `query` into the find bar and presses Enter, which finds at once. */
async function find(query: string): Promise<void> {
  const input = await findInput();
  await input.setValue(query);
  await browser.keys("Enter");
}

/** How many ranges a highlight holds, in Obsidian's window or in the page's frame. */
async function highlighted(name: string, inPage: boolean): Promise<number> {
  return browser.execute(
    (active, name, inPage) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      );
      const target = (inPage ? frame?.contentWindow : window) as
        (Window & typeof globalThis) | null;
      return target?.CSS.highlights.get(name)?.size ?? 0;
    },
    ACTIVE,
    name,
    inPage,
  );
}

/**
 * Finds each of `queries` in turn through the find bar's input and its Enter key, and returns the
 * count that the bar shows for each. It takes one WebDriver call, where typing each query takes
 * four; the other tests type theirs.
 */
async function findEach(queries: string[]): Promise<Record<string, string>> {
  const counts = await browser.execute(
    (active, queries) => {
      const input = document.querySelector<HTMLInputElement>(
        `${active} .html-page-viewer__find input`,
      );
      const count = document.querySelector(`${active} .html-page-viewer__find-count`);
      if (!input || !count) throw new Error("The find bar is not open");
      return queries.map((query) => {
        input.value = query;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return count.textContent ?? "";
      });
    },
    ACTIVE,
    queries,
  );
  return Object.fromEntries(queries.map((query, index) => [query, counts[index]]));
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Text rects in a page, in CSS pixels, and the width of the page's viewport. */
interface Area {
  readonly rects: Rect[];
  readonly width: number;
}

/**
 * How many pixels inside `area` differ between two captures of the frame. Only the area counts,
 * so that native control animations elsewhere in the frame do not: a painted glyph has a text
 * rect, and boxless text cannot contribute glyph pixels.
 */
function changedPixels(a: Pixels, b: Pixels, area: Area): number {
  const scale = a.width / area.width;
  let changes = 0;
  for (const rect of area.rects) {
    const bottom = Math.min(a.height, Math.ceil(rect.bottom * scale));
    const right = Math.min(a.width, Math.ceil(rect.right * scale));
    for (let y = Math.max(0, Math.floor(rect.top * scale)); y < bottom; y++) {
      for (let x = Math.max(0, Math.floor(rect.left * scale)); x < right; x++) {
        const index = (y * a.width + x) * 3;
        if (!a.rgb.subarray(index, index + 3).equals(b.rgb.subarray(index, index + 3))) changes++;
      }
    }
  }
  return changes;
}

async function closeFind(): Promise<void> {
  await (await findInput()).click();
  await browser.keys("Escape");
  await expect(browser.$(`${ACTIVE} .html-page-viewer__find`)).not.toBeExisting();
}

/** The body of the last {@link stoppable} test, settled once it has stopped. */
let running: Promise<unknown> = Promise.resolve();

/**
 * A test whose code cannot outlive its result. A test that times out fails, but its code goes on
 * driving Obsidian, and would change what the next tests see (#160). The body calls `step()`
 * between its long steps, which throws once the test has a result, and `afterEach` waits for the
 * body to stop before it cleans up for the next test.
 */
function stoppable(body: (step: () => void) => Promise<void>): Mocha.AsyncFunc {
  return function () {
    const test = this.test;
    const run = body(() => {
      if (test?.state !== undefined) throw new Error(`Stopped: the test has ${test.state}`);
    });
    running = run.catch(() => undefined);
    return run;
  };
}

describe("Finding text in Obsidian", function () {
  // Each test starts with the find bar closed, in the rendered view, with scripts off.
  afterEach(async function () {
    await running;
    await browser.execute((active) => {
      const input = document.querySelector<HTMLInputElement>(
        `${active} .html-page-viewer__find input`,
      );
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          `${active} .html-page-viewer__toolbar button`,
        ),
      ];
      buttons.find((button) => button.textContent === "Rendered")?.click();
      buttons.find((button) => button.textContent === "Scripts ON")?.click();
    }, ACTIVE);
  });

  it(
    "finds exactly the page's text that Obsidian shows, and all of it in the source",
    stoppable(async (step) => {
      // Each word is isolated by its class for its paint screenshot.
      const html = [
        `<p class="visibleword">visibleword</p>`,
        `<p class="hiddenword" style="visibility:hidden">hiddenword <span class="inheritedword">inheritedword</span> <span class="overrideword" style="visibility:visible">overrideword</span></p>`,
        `<div class="transparentword" style="opacity:0">transparentword <span class="opaquechild" style="opacity:1">opaquechild</span></div>`,
        `<div class="contentsword" style="display:contents">contentsword</div>`,
        `<div class="contentsopacity" style="display:contents;opacity:0">contentsopacity <span class="contentschild">contentschild</span></div>`,
        `<div class="hiddencontents" style="display:contents;visibility:hidden">hiddencontents <span class="contentsoverride" style="visibility:visible">contentsoverride</span></div>`,
        `<div class="displayword" style="display:none">displayword</div>`,
        `<div class="cvdirect" style="content-visibility:hidden">cvdirect<p class="cvchild">cvchild</p></div>`,
        `<p><span class="cvinline" style="content-visibility:hidden">cvinline</span> <ruby class="cvruby" style="content-visibility:hidden">cvruby<rt>ruby</rt></ruby></p>`,
        `<div class="cvcontents" style="display:contents;content-visibility:hidden">cvcontents</div>`,
        `<table style="content-visibility:hidden"><tr><td class="cvtable">cvtable</td></tr></table>`,
        `<table><caption class="cvcaption" style="content-visibility:hidden">cvcaption</caption><tr><td class="cvcell" style="content-visibility:hidden">cvcell</td></tr></table>`,
        `<progress value="1" max="2"><span class="progresschild">progresschild</span></progress>`,
        `<p><canvas class="canvasfallback">canvasfallback</canvas></p>`,
        `<video class="videofallback" width="60" height="30">videofallback</video>`,
        `<audio class="audiofallback">audiofallback</audio>`,
      ];
      html.push(
        '<iframe class="iframetext" style="width:60px;height:20px">iframetext</iframe>',
        '<progress value="1" max="2" class="progresstext">progresstext</progress><meter class="metertext">metertext</meter>',
        '<canvas class="cvcanvas" style="content-visibility:hidden" width="60" height="30">cvcanvas</canvas>',
        ...["defs", "symbol", "clipPath", "mask", "pattern", "marker"].map(
          (tag) =>
            `<svg width="240" height="30" class="${tag}word"><${tag}><text y="24">${tag}word</text></${tag}></svg>`,
        ),
        '<svg width="240" height="30" class="svgdirect">svgdirect</svg>',
        '<svg width="240" height="30" class="svgcontrol"><g><text y="24">svgcontrol</text></g></svg>',
        '<svg width="240" height="30"><foreignObject width="240" height="30" class="foreignword">foreignword</foreignObject></svg>',
        '<svg width="240" height="30"><switch><text y="24" systemLanguage="xx-nowhere" class="switchskipped">switchskipped</text><text y="24" class="switchshown">switchshown</text></switch></svg>',
        '<select><option class="unchosen">unchosen</option><option class="chosen" selected>chosen</option></select>',
      );
      const shown = [
        "foreignword",
        "switchshown",
        "svgcontrol",
        "chosen",
        "visibleword",
        "overrideword",
        "contentsword",
        "contentsopacity",
        "contentschild",
        "contentsoverride",
        "cvinline",
        "cvruby",
        "cvcontents",
        "cvtable",
        "canvasfallback",
      ];
      // Hidden words asserted to have no layout box. Other hidden words may have none either; their
      // paint check then compares an empty area, and find must still leave them out.
      const boxless = ["displayword", "progresschild", "videofallback", "audiofallback"];
      const hidden = [
        "switchskipped",
        "hiddenword",
        "inheritedword",
        "transparentword",
        "opaquechild",
        "hiddencontents",
        "cvdirect",
        "cvchild",
        "cvcaption",
        "cvcell",
        ...boxless,
        "iframetext",
        "progresstext",
        "metertext",
        "cvcanvas",
        "defsword",
        "symbolword",
        "clipPathword",
        "maskword",
        "patternword",
        "markerword",
        "svgdirect",
        "unchosen",
      ];
      const words = [...shown, ...hidden];
      const style = [
        "body { margin: 8px; background: #fff; font: bold 24px/1.25 sans-serif; }",
        "p, table { margin: 0; } svg { fill: currentColor; } select { font: inherit; color: black; }",
        ...words.map((word) => `.${word} { color: black; }`),
      ].join("\n");
      await browser.executeObsidian(
        async ({ app }, html) => {
          const path = "Saved/Find visibility.html";
          const existing = app.vault.getAbstractFileByPath(path);
          if (existing) await app.vault.modify(existing as never, html);
          else await app.vault.create(path, html);
        },
        `<!doctype html><style>${style}</style>${html.join("\n")}`,
      );
      await openInActiveTab("Saved/Find visibility.html");
      await waitForPage();
      expect(
        await browser.execute((active) => {
          const doc = document.querySelector<HTMLIFrameElement>(
            active + " iframe",
          )!.contentDocument!;
          return doc.documentElement.scrollHeight <= doc.documentElement.clientHeight;
        }, ACTIVE),
      ).toBe(true);
      await saveScreenshot("find-visibility");
      const frame = await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`);
      const capture = async (): Promise<Pixels> =>
        decodePng(
          Buffer.from(await browser.takeElementScreenshot(await frame.elementId), "base64"),
        );
      /**
       * Makes only `word`'s colour transparent, or no word's, and returns `word`'s text rects with
       * the page's layout: the box of each of its elements.
       */
      const paintWithout = async (word: string | null): Promise<Area & { layout: string }> =>
        browser.execute(
          (active, words, word) => {
            const doc = document.querySelector<HTMLIFrameElement>(
              active + " iframe",
            )!.contentDocument!;
            for (const each of words)
              doc.querySelector<HTMLElement>("." + each)!.style.removeProperty("color");
            doc.querySelector("select")!.style.removeProperty("color");
            const rects: Rect[] = [];
            const width = doc.documentElement.clientWidth;
            const layout = () =>
              [...doc.body.querySelectorAll("*")]
                .map((element) => JSON.stringify(element.getBoundingClientRect()))
                .join();
            if (word === null) return { rects, width, layout: layout() };
            const element = doc.querySelector<HTMLElement>("." + word)!;
            element.style.color = "transparent";
            if (word === "chosen") element.closest("select")!.style.color = "transparent";
            const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.textContent?.trim() !== word) continue;
              const range = doc.createRange();
              range.selectNodeContents(node);
              for (const rect of range.getClientRects()) rects.push(rect.toJSON());
            }
            if (word === "chosen")
              rects.push(element.closest("select")!.getBoundingClientRect().toJSON());
            return { rects, width, layout: layout() };
          },
          ACTIVE,
          words,
          word,
        );
      /** A capture of the whole page, with the layout it shows. */
      const captureAll = async (): Promise<{ pixels: Pixels; layout: string }> => {
        const { layout } = await paintWithout(null);
        return { pixels: await capture(), layout };
      };
      // Compare a capture of the whole page with one for each word, in which that word's colour
      // alone is transparent and the layout is the same. This detects any paint, including LCD
      // antialiasing, without classifying colours that other words' smoothed edges can also
      // produce. Explicit child colours keep descendant fixture words unchanged when their parent
      // is transparent.
      let shot = await captureAll();
      const painted: Record<string, number> = {};
      const areas: Area[] = [];
      for (const word of words) {
        step();
        let area = await paintWithout(word);
        if (area.layout !== shot.layout) {
          // Chromium lays out a table cell and a canvas with `content-visibility: hidden` at the
          // size of their contents once their colour changes, and moves what follows them.
          // Capture the whole page again in that layout.
          shot = await captureAll();
          area = await paintWithout(word);
          expect({ word, sameLayout: area.layout === shot.layout }).toEqual({
            word,
            sameLayout: true,
          });
        }
        const without = await capture();
        expect([without.width, without.height]).toEqual([shot.pixels.width, shot.pixels.height]);
        painted[word] = changedPixels(shot.pixels, without, area);
        areas.push(area);
      }
      // The comparisons hold only while the page paints as it did in the last capture of all of
      // it, in every word's area.
      step();
      const after = await captureAll();
      const drift = areas.reduce(
        (sum, area) => sum + changedPixels(shot.pixels, after.pixels, area),
        0,
      );
      expect({ sameLayout: after.layout === shot.layout, drift }).toEqual({
        sameLayout: true,
        drift: 0,
      });
      const boxes = await browser.execute(
        (active, words) => {
          const doc = document.querySelector<HTMLIFrameElement>(
            `${active} iframe.html-page-viewer__frame`,
          )?.contentDocument;
          if (!doc) throw new Error("No page in the frame");
          const counts: Record<string, number> = {};
          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const word = node.textContent?.trim() ?? "";
            if (!words.includes(word)) continue;
            const range = doc.createRange();
            range.selectNodeContents(node);
            counts[word] = range.getClientRects().length;
          }
          return counts;
        },
        ACTIVE,
        words,
      );
      for (const word of shown) expect([word, painted[word] > 0]).toEqual([word, true]);
      for (const word of hidden) expect([word, painted[word]]).toEqual([word, 0]);
      for (const word of boxless) expect([word, boxes[word]]).toEqual([word, 0]);

      step();
      await browser.$(`${ACTIVE} button[aria-label="Find in page"]`).click();
      const each = (queries: string[], count: string) =>
        Object.fromEntries(queries.map((query) => [query, count]));
      expect(await findEach(shown)).toEqual(each(shown, "1 of 1"));
      // Chromium paints no highlight on a closed select's label.
      await findEach(["chosen"]);
      expect(await framePixels(CURRENT)).toBe(0);
      expect(await findEach(hidden)).toEqual(each(hidden, "No matches"));
      await clickToolbarButton("Source");
      // In the source, each word is also its element's class and a rule's selector.
      expect(await findEach(hidden)).toEqual(each(hidden, "1 of 3"));
      await closeFind();
    }),
  );

  it("finds and paints highlights in nested shadow roots and slots", async function () {
    await browser.executeObsidian(async ({ app }) => {
      const path = "Saved/Find shadow.html";
      const html =
        '<div><template shadowrootmode="closed"><style>i:last-child { color: rgb(12, 34, 56); }</style>shadow <em>phrase</em><slot name="named">fallbackword</slot><div><template shadowrootmode="open"><p>nestedword</p></template></div><i>lastword</i></template><span slot="named">slottedword</span><span>unassignedword</span></div><div>defaultword<template shadowrootmode="open"><b><slot></slot></b></template></div>';
      const old = app.vault.getAbstractFileByPath(path);
      if (old) await app.vault.modify(old as never, html);
      else await app.vault.create(path, html);
    });
    await openInActiveTab("Saved/Find shadow.html");
    await waitForPage();
    const structure = async (): Promise<unknown> =>
      browser.execute((active) => {
        const root = document
          .querySelector<HTMLIFrameElement>(active + " iframe")!
          .contentDocument!.querySelector("div")!.shadowRoot!;
        return {
          children: root.childNodes.length,
          color: root.ownerDocument.defaultView!.getComputedStyle(root.querySelector("i")!).color,
          sheets: root.adoptedStyleSheets.length,
        };
      }, ACTIVE);
    const before = await structure();
    await browser.$(ACTIVE + ' button[aria-label="Find in page"]').click();
    for (const word of ["shadow phrase", "nestedword", "slottedword", "defaultword"]) {
      await find(word);
      expect(await findCount()).toBe("1 of 1");
      expect(await framePixels(CURRENT)).toBeGreaterThan(20);
      const during = (await structure()) as { children: number; color: string; sheets: number };
      expect(during.color).toBe("rgb(12, 34, 56)");
      expect(during.children).toBe((before as { children: number }).children);
    }
    for (const word of ["unassignedword", "fallbackword", "phraseslottedword"]) {
      await find(word);
      expect(await findCount()).toBe("No matches");
    }
    // An empty query after a match removes the highlight stylesheet again.
    await find("shadow phrase");
    await find("");
    expect(await structure()).toEqual(before);
    await find("shadow phrase");
    await closeFind();
    expect(await framePixels(CURRENT)).toBe(0);
    expect(await structure()).toEqual(before);
  });

  it("finds in a page, highlights the matches, and moves from one to the next", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    await browser.$(`${ACTIVE} button[aria-label="Find in page"]`).click();
    await find("saved");
    expect(await findCount()).toBe("1 of 2");
    expect(await highlighted("html-page-viewer-match", true)).toBe(2);
    expect(await highlighted("html-page-viewer-current", true)).toBe(1);
    await saveScreenshot("find-in-page");
    expect(await framePixels(CURRENT)).toBeGreaterThan(20);

    await browser.keys("Enter");
    expect(await findCount()).toBe("2 of 2");
    await browser.keys(["Shift", "Enter"]);
    expect(await findCount()).toBe("1 of 2");
    await closeFind();
    expect(await highlighted("html-page-viewer-match", true)).toBe(0);
  });

  it("opens with Ctrl+F from inside the page", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    const point = await browser.execute((active) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      );
      const heading = frame?.contentDocument?.querySelector("h1");
      if (!frame || !heading) throw new Error("No heading in the page");
      const outer = frame.getBoundingClientRect();
      const inner = heading.getBoundingClientRect();
      return {
        x: Math.round(outer.left + inner.left + 10),
        y: Math.round(outer.top + inner.top + inner.height / 2),
      };
    }, ACTIVE);
    await browser.action("pointer").move(point).down().up().perform();
    await browser.keys(["Control", "f"]);
    await expect(findInput()).toBeFocused();
    await closeFind();
  });

  it("finds in the source view, which Ctrl+F opens while the view has focus", async function () {
    await openInActiveTab("Saved/Example article.html");
    await clickToolbarButton("Source");
    await browser.$(`${ACTIVE} .html-page-viewer__source`).click();
    await browser.keys(["Control", "f"]);
    await expect(findInput()).toBeFocused();
    // The article has three paragraphs.
    await find("<p");
    expect(await findCount()).toBe("1 of 3");
    expect(await highlighted("html-page-viewer-match", false)).toBe(3);
    await closeFind();
    expect(await highlighted("html-page-viewer-match", false)).toBe(0);
    await clickToolbarButton("Rendered");
  });

  it("finds only in the source view while scripts are on", async function () {
    await openInActiveTab("Saved/Example article.html");
    await clickToolbarButton("Scripts OFF");
    await browser.$(`${ACTIVE} button[aria-label="Find in page"]`).click();
    expect(await findCount()).toBe("Find works in the source view while scripts are on.");
    await closeFind();
    await clickToolbarButton("Scripts ON");
  });
});
