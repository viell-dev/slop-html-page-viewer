import { browser, expect } from "@wdio/globals";
import { type Color, decodePng } from "../support/pixels.ts";
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

async function closeFind(): Promise<void> {
  await (await findInput()).click();
  await browser.keys("Escape");
  await expect(browser.$(`${ACTIVE} .html-page-viewer__find`)).not.toBeExisting();
}

describe("Finding text in Obsidian", function () {
  // Each test starts with the find bar closed, in the rendered view, with scripts off.
  afterEach(async function () {
    await browser.execute((active) => {
      const input = document.querySelector<HTMLInputElement>(` .html-page-viewer__find input`);
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(` .html-page-viewer__toolbar button`),
      ];
      buttons.find((button) => button.textContent === "Rendered")?.click();
      buttons.find((button) => button.textContent === "Scripts ON")?.click();
    }, ACTIVE);
  });

  it("finds exactly the page's text that Obsidian shows, and all of it in the source", async function () {
    // Each word's element has the word as its class, which gives it a colour of
    // its own, so that one screenshot shows which words the page paints.
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
    const shown = [
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
    // Hidden words that have no box at all; the others are laid out but not painted.
    const boxless = ["displayword", "progresschild", "videofallback", "audiofallback"];
    const hidden = [
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
    ];
    const words = [...shown, ...hidden];
    // Colours without green: smoothing a glyph's edge against the white background
    // adds green, so an edge pixel never matches another word's colour.
    const colors = words.map((_, index): Color => [
      40 + 40 * (index % 6),
      0,
      60 * Math.floor(index / 6),
    ]);
    const style = [
      "body { margin: 8px; background: #fff; font: bold 24px/1.25 sans-serif; }",
      "p, table { margin: 0; }",
      ...words.map((word, index) => `.${word} { color: rgb(${colors[index].join(", ")}); }`),
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
    await saveScreenshot("find-visibility");
    const frame = await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`);
    const shot = decodePng(
      Buffer.from(await browser.takeElementScreenshot(await frame.elementId), "base64"),
    );
    const painted = Object.fromEntries(
      words.map((word, index) => [word, shot.count(colors[index])]),
    );
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

    await browser.$(`${ACTIVE} button[aria-label="Find in page"]`).click();
    for (const word of shown) {
      await find(word);
      expect([word, await findCount()]).toEqual([word, "1 of 1"]);
    }
    for (const word of hidden) {
      await find(word);
      expect([word, await findCount()]).toEqual([word, "No matches"]);
    }
    await clickToolbarButton("Source");
    for (const word of hidden) {
      await find(word);
      // In the source, the word is also its element's class and a rule's selector.
      expect([word, await findCount()]).toEqual([word, "1 of 3"]);
    }
    await closeFind();
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
