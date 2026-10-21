import { browser, expect } from "@wdio/globals";
import { ACTIVE, clickToolbarButton, openInActiveTab, waitForPage } from "../support/viewer.ts";

// In the long page, paragraph N is on line 8 + N of the source.
const PAGE = "Saved/Long page.html";

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Where the split view's two sides are on screen. */
async function sides(): Promise<{ source: Box; page: Box }> {
  return browser.execute((active) => {
    const box = (selector: string): Box => {
      const rect = document.querySelector(`${active} .html-page-viewer__split > ${selector}`)?.getBoundingClientRect();
      if (!rect) throw new Error(`No ${selector} in the split view`);
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    };
    return { source: box(".html-page-viewer__source"), page: box(".html-page-viewer__frame-wrap") };
  }, ACTIVE);
}

/** The number of the first paragraph the page shows at its top. */
async function topParagraph(): Promise<number> {
  return browser.execute((active) => {
    const frame = document.querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`);
    const paragraphs = [...(frame?.contentDocument?.querySelectorAll("p") ?? [])];
    const first = paragraphs.find((paragraph) => paragraph.getBoundingClientRect().bottom > 1);
    return Number(/Paragraph (\d+)/.exec(first?.textContent ?? "")?.[1] ?? 0);
  }, ACTIVE);
}

/** The number of the first line the source shows at its top. */
async function topLine(): Promise<number> {
  return browser.execute((active) => {
    const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__split .html-page-viewer__source`);
    const lines = [...(source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line") ?? [])];
    const index = lines.findIndex((line) => line.offsetTop + line.offsetHeight > (source?.scrollTop ?? 0) + 1);
    return index + 1;
  }, ACTIVE);
}

describe("The split view in Obsidian", function () {
  afterEach(async function () {
    await browser.execute((active) => {
      const content = document.querySelector<HTMLElement>(`${active} .view-content`);
      content?.style.removeProperty("width");
    }, ACTIVE);
    await clickToolbarButton("Rendered");
  });

  it("shows the source beside the page, and above it in a narrow view", async function () {
    await openInActiveTab(PAGE);
    await clickToolbarButton("Split");
    await waitForPage();
    const wide = await sides();
    expect(wide.source.right).toBeLessThanOrEqual(wide.page.left);

    await browser.execute((active) => {
      document.querySelector<HTMLElement>(`${active} .view-content`)?.style.setProperty("width", "500px");
    }, ACTIVE);
    await browser.pause(200);
    const narrow = await sides();
    expect(narrow.source.bottom).toBeLessThanOrEqual(narrow.page.top);
  });

  it("scrolls the page with the source, and the source with the page", async function () {
    await openInActiveTab(PAGE);
    await clickToolbarButton("Split");
    await waitForPage();

    // Targets that both sides can scroll to the top of: the source shows about forty of its lines.
    // Line 20 is paragraph 12's.
    await browser.execute((active) => {
      const source = document.querySelector<HTMLElement>(`${active} .html-page-viewer__split .html-page-viewer__source`);
      const line = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[19];
      if (!source || !line) throw new Error("No line 20");
      source.scrollTop = line.offsetTop;
    }, ACTIVE);
    await browser.waitUntil(async () => Math.abs((await topParagraph()) - 12) <= 1, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the source to paragraph 12",
    });

    // Paragraph 18 is on line 26.
    await browser.execute((active) => {
      const frame = document.querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`);
      const win = frame?.contentWindow;
      const paragraph = [...(frame?.contentDocument?.querySelectorAll("p") ?? [])].find((p) => p.textContent?.startsWith("Paragraph 18 "));
      if (!win || !paragraph) throw new Error("No paragraph 18");
      win.scrollTo(0, paragraph.getBoundingClientRect().top + win.scrollY);
    }, ACTIVE);
    await browser.waitUntil(async () => Math.abs((await topLine()) - 26) <= 1, {
      timeout: 5000,
      timeoutMsg: "the source did not follow the page to line 26",
    });
  });
});
