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
      const rect = document
        .querySelector(`${active} .html-page-viewer__split > ${selector}`)
        ?.getBoundingClientRect();
      if (!rect) throw new Error(`No ${selector} in the split view`);
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    };
    return { source: box(".html-page-viewer__source"), page: box(".html-page-viewer__frame-wrap") };
  }, ACTIVE);
}

/** The number of the first paragraph the page shows at its top, also in a shadow root. */
async function topParagraph(): Promise<number> {
  return browser.execute((active) => {
    const frame = document.querySelector<HTMLIFrameElement>(
      `${active} iframe.html-page-viewer__frame`,
    );
    const paragraphs: Element[] = [];
    const collect = (root: ParentNode): void => {
      for (const element of root.querySelectorAll("*")) {
        if (element.localName === "p") paragraphs.push(element);
        if (element.shadowRoot) collect(element.shadowRoot);
      }
    };
    if (frame?.contentDocument) collect(frame.contentDocument);
    // The highest of those still in view: slots show a shadow root's
    // paragraphs and their host's own in another order than the document's.
    let first: Element | undefined;
    let firstTop = Infinity;
    for (const paragraph of paragraphs) {
      const box = paragraph.getBoundingClientRect();
      if (box.bottom > 1 && box.top < firstTop) [first, firstTop] = [paragraph, box.top];
    }
    return Number(/Paragraph (\d+)/.exec(first?.textContent ?? "")?.[1] ?? 0);
  }, ACTIVE);
}

/** Scrolls the page to the top of a paragraph, by its number, also in a shadow root. */
async function scrollPageToParagraph(number: number): Promise<void> {
  await browser.execute(
    (active, number) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      );
      const win = frame?.contentWindow;
      const find = (root: ParentNode): Element | undefined => {
        for (const element of root.querySelectorAll("*")) {
          if (element.localName === "p" && element.textContent?.startsWith(`Paragraph ${number} `))
            return element;
          const inside = element.shadowRoot ? find(element.shadowRoot) : undefined;
          if (inside) return inside;
        }
        return undefined;
      };
      const paragraph = frame?.contentDocument ? find(frame.contentDocument) : undefined;
      if (!win || !paragraph) throw new Error(`No paragraph ${number}`);
      win.scrollTo(0, paragraph.getBoundingClientRect().top + win.scrollY);
    },
    ACTIVE,
    number,
  );
}

/** Checks that where a side stopped is within one of where it should be. */
function expectNear(value: number, expected: number): void {
  expect(value).toBeGreaterThanOrEqual(expected - 1);
  expect(value).toBeLessThanOrEqual(expected + 1);
}

/** Scrolls the split view's source to the top of a line, from 1. */
async function scrollSourceTo(line: number): Promise<void> {
  await browser.execute(
    (active, line) => {
      const source = document.querySelector<HTMLElement>(
        `${active} .html-page-viewer__split .html-page-viewer__source`,
      );
      const element = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[
        line - 1
      ];
      if (!source || !element) throw new Error(`No line ${line}`);
      source.scrollTop = element.offsetTop;
    },
    ACTIVE,
    line,
  );
}

/**
 * Waits until `read` gives a value within one of `expected`, for at most five
 * seconds, and returns the last value it gave, so that a test that fails says
 * where the side stopped.
 */
async function settledNear(read: () => Promise<number>, expected: number): Promise<number> {
  let value = await read();
  await browser
    .waitUntil(async () => Math.abs((value = await read()) - expected) <= 1, { timeout: 5000 })
    .catch(() => undefined);
  return value;
}

/** The number of the first line the source shows at its top. */
async function topLine(): Promise<number> {
  return browser.execute((active) => {
    const source = document.querySelector<HTMLElement>(
      `${active} .html-page-viewer__split .html-page-viewer__source`,
    );
    const lines = [
      ...(source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line") ?? []),
    ];
    const index = lines.findIndex(
      (line) => line.offsetTop + line.offsetHeight > (source?.scrollTop ?? 0) + 1,
    );
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
      document
        .querySelector<HTMLElement>(`${active} .view-content`)
        ?.style.setProperty("width", "500px");
    }, ACTIVE);
    await browser.pause(200);
    const narrow = await sides();
    expect(narrow.source.bottom).toBeLessThanOrEqual(narrow.page.top);
  });

  it("keeps in step with a page that scrolls smoothly under a fixed header", async function () {
    // Paragraph N is on line 10 + N of this page's source.
    await openInActiveTab("Saved/Smooth page.html");
    await clickToolbarButton("Split");
    await waitForPage();

    await browser.execute((active) => {
      const source = document.querySelector<HTMLElement>(
        `${active} .html-page-viewer__split .html-page-viewer__source`,
      );
      const line = source?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[19];
      if (!source || !line) throw new Error("No line 20");
      source.scrollTop = line.offsetTop;
    }, ACTIVE);
    await browser.waitUntil(async () => Math.abs((await topParagraph()) - 10) <= 1, {
      timeout: 5000,
      timeoutMsg: "the page did not follow the source to paragraph 10",
    });
    // The page's own smooth scrolling must not pull the source back.
    await browser.pause(800);
    expect(Math.abs((await topLine()) - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs((await topParagraph()) - 10)).toBeLessThanOrEqual(1);

    await browser.execute((active) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      );
      const win = frame?.contentWindow;
      const root = frame?.contentDocument?.documentElement;
      const paragraph = [...(frame?.contentDocument?.querySelectorAll("p") ?? [])].find((p) =>
        p.textContent?.startsWith("Paragraph 15 "),
      );
      if (!win || !root || !paragraph) throw new Error("No paragraph 15");
      // A user's scroll, which the page's style does not animate.
      root.style.scrollBehavior = "auto";
      win.scrollTo(0, paragraph.getBoundingClientRect().top + win.scrollY);
      root.style.scrollBehavior = "";
    }, ACTIVE);
    await browser.waitUntil(async () => Math.abs((await topLine()) - 25) <= 1, {
      timeout: 5000,
      timeoutMsg: "the source did not follow the page to line 25",
    });
  });

  it("scrolls the page with the source, and the source with the page", async function () {
    await openInActiveTab(PAGE);
    await clickToolbarButton("Split");
    await waitForPage();

    // Targets that both sides can scroll to the top of: the source shows about forty of its lines.
    // Line 20 is paragraph 12's.
    await browser.execute((active) => {
      const source = document.querySelector<HTMLElement>(
        `${active} .html-page-viewer__split .html-page-viewer__source`,
      );
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
      const frame = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      );
      const win = frame?.contentWindow;
      const paragraph = [...(frame?.contentDocument?.querySelectorAll("p") ?? [])].find((p) =>
        p.textContent?.startsWith("Paragraph 18 "),
      );
      if (!win || !paragraph) throw new Error("No paragraph 18");
      win.scrollTo(0, paragraph.getBoundingClientRect().top + win.scrollY);
    }, ACTIVE);
    await browser.waitUntil(async () => Math.abs((await topLine()) - 26) <= 1, {
      timeout: 5000,
      timeoutMsg: "the source did not follow the page to line 26",
    });
  });

  it("shows the page where the reader scrolled the source before it first showed (#215)", async function () {
    // Paragraph N is on line 1 + N. Reading the stylesheet waits for the test.
    const paragraphs = Array.from({ length: 200 }, (_, index) => `<p>Paragraph ${index + 1} </p>`);
    const files = {
      "Held page.html": ['<link rel="stylesheet" href="Held page.css">', ...paragraphs].join("\n"),
      "Held page.css": "p { color: green }",
    };
    await browser.executeObsidian(async ({ app }, files) => {
      for (const [path, text] of Object.entries(files)) await app.vault.create(path, text);
      const vault = app.vault as unknown as {
        cachedRead(file: { path: string }): Promise<string>;
      };
      const own = Object.hasOwn(vault, "cachedRead");
      const read = vault.cachedRead;
      const held = new Promise<void>((resolve) => {
        Object.assign(window, { e2eRelease: resolve });
      });
      vault.cachedRead = async (file) => {
        if (file.path === "Held page.css") await held;
        return read.call(vault, file);
      };
      Object.assign(window, {
        e2eRestore: () => {
          if (own) vault.cachedRead = read;
          else delete (vault as { cachedRead?: unknown }).cachedRead;
        },
      });
    }, files);
    const release = () =>
      browser.execute(() => (window as unknown as { e2eRelease(): void }).e2eRelease());
    try {
      await openInActiveTab(PAGE);
      await clickToolbarButton("Split");
      await waitForPage();
      await openInActiveTab("Held page.html");
      const scrolled = await browser.execute(async (active) => {
        const view = document.querySelector(active)!;
        const source = view.querySelector<HTMLElement>(".html-page-viewer__source")!;
        const line = source.querySelectorAll<HTMLElement>(".html-page-viewer__source-line")[100];
        const reported = new Promise((resolve) =>
          source.addEventListener("scroll", resolve, { once: true }),
        );
        source.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 200 }));
        source.scrollTop = line.offsetTop;
        await reported;
        return { srcdoc: view.querySelector("iframe")!.srcdoc };
      }, ACTIVE);
      expect(scrolled).toEqual({ srcdoc: "" });
      await release();
      await waitForPage();
      expectNear(await settledNear(topParagraph, 100), 100);
      expectNear(await topLine(), 101);
    } finally {
      await release();
      await browser.execute(() => (window as unknown as { e2eRestore(): void }).e2eRestore());
      await browser.executeObsidian(async ({ app }, paths) => {
        for (const path of paths) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file);
        }
      }, Object.keys(files));
    }
  });

  it("keeps in step with a page whose article is in a shadow root (#124)", async function () {
    // In the shadow root, after a tall figure, paragraph N is on line 9 + N.
    await openInActiveTab("Saved/Shadow page.html");
    await clickToolbarButton("Split");
    await waitForPage();

    await scrollSourceTo(39);
    expectNear(await settledNear(topParagraph, 30), 30);
    await scrollPageToParagraph(40);
    expectNear(await settledNear(topLine, 49), 49);
  });

  it("keeps in step with a page whose body has a shadow root (#124)", async function () {
    // In the body's shadow root, after a tall figure, paragraph N is on line
    // 9 + N; after it, in the body's own content, on line 11 + N.
    await openInActiveTab("Saved/Shadow body.html");
    await clickToolbarButton("Split");
    await waitForPage();

    await scrollSourceTo(39);
    expectNear(await settledNear(topParagraph, 30), 30);
    await scrollPageToParagraph(70);
    expectNear(await settledNear(topLine, 81), 81);
  });

  it("keeps in step with a shadow root declared after some of its host's content (#124)", async function () {
    // Paragraph N is on line 8 + N before the declaration, on line 11 + N in
    // the shadow root, and on line 13 + N after it; the slots show them in
    // that order. Before paragraph 1, the page has a comment with the text of
    // the view's mark, which must not be taken for one.
    await openInActiveTab("Saved/Shadow late.html");
    await clickToolbarButton("Split");
    await waitForPage();

    await scrollSourceTo(23);
    expectNear(await settledNear(topParagraph, 15), 15);
    await scrollSourceTo(56);
    expectNear(await settledNear(topParagraph, 45), 45);
    await scrollPageToParagraph(75);
    expectNear(await settledNear(topLine, 88), 88);
  });
});
