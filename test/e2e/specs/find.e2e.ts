import { browser, expect } from "@wdio/globals";
import type { Color } from "../support/pixels.ts";
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
