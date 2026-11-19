import http from "node:http";
import type { AddressInfo } from "node:net";
import { browser, expect } from "@wdio/globals";
import {
  ACTIVE,
  activeFile,
  clickInPage,
  clickToolbarButton,
  moveActiveTab,
  openInActiveTab,
  VIEW_TYPE,
  waitForPage,
} from "../support/viewer.ts";

const CONTROL = "";

/** Records the URLs the plugin hands to window.open, instead of opening them. */
async function recordWindowOpen(): Promise<void> {
  await browser.execute(() => {
    const state = window as unknown as { e2eOpened: string[]; e2eWindowOpen?: typeof window.open };
    const opened: string[] = [];
    state.e2eOpened = opened;
    // Obsidian opens its own windows with it too, so restoreWindowOpen puts it back.
    state.e2eWindowOpen ??= window.open;
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });
}

async function restoreWindowOpen(): Promise<void> {
  await browser.execute(() => {
    const state = window as unknown as { e2eWindowOpen?: typeof window.open };
    if (state.e2eWindowOpen) window.open = state.e2eWindowOpen;
  });
}

async function openedUrls(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { e2eOpened?: string[] }).e2eOpened ?? []);
}

async function frameLocation(): Promise<string> {
  return browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      ".workspace-leaf.mod-active iframe.html-page-viewer__frame",
    );
    try {
      return frame?.contentWindow?.location.href ?? "none";
    } catch {
      return "cross-origin";
    }
  });
}

interface Navigation {
  url: string;
  canceled: boolean;
}

/**
 * Records each navigation that a frame starts, and whether the view canceled
 * it: added after the view's own listener, this one runs after it.
 */
async function recordNavigations(
  selector = `${ACTIVE} iframe.html-page-viewer__frame`,
): Promise<void> {
  await browser.execute((selector) => {
    const frame = document.querySelector<HTMLIFrameElement>(selector)!;
    const seen: { url: string; canceled: boolean }[] = [];
    (window as unknown as { e2eNavigations: typeof seen }).e2eNavigations = seen;
    const win = frame.contentWindow as unknown as { navigation: EventTarget };
    win.navigation.addEventListener("navigate", (event) => {
      const { destination } = event as Event & { destination: { url: string } };
      seen.push({ url: destination.url, canceled: event.defaultPrevented });
    });
  }, selector);
}

/** The navigations recorded so far. A click's navigation is recorded during the click. */
async function recordedNavigations(): Promise<Navigation[]> {
  return browser.execute(
    () => (window as unknown as { e2eNavigations?: Navigation[] }).e2eNavigations ?? [],
  );
}

/** Waits until a click has started a navigation, and returns those recorded. */
async function startedNavigations(): Promise<Navigation[]> {
  await browser.waitUntil(async () => (await recordedNavigations()).length > 0, {
    timeoutMsg: "the click started no navigation",
  });
  return recordedNavigations();
}

/**
 * Runs `test` with a vault page open in the active tab whose load event never
 * comes: its image is on a server that never answers, so the test acts after
 * the page is parsed and before it has loaded.
 */
async function withPageStillLoading(body: string, test: () => Promise<void>): Promise<void> {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Still loading</title></head><body>${body}<img src="http://127.0.0.1:${port}/never.png" alt="An image that never arrives" width="16" height="16"></body></html>`;
    await browser.executeObsidian(async ({ app }, html) => {
      const path = "Saved/Still loading.html";
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) await app.vault.modify(existing as never, html);
      else await app.vault.create(path, html);
    }, html);
    await openInActiveTab("Saved/Still loading.html");
    await browser.waitUntil(
      async () =>
        browser.execute((active) => {
          const doc = document.querySelector<HTMLIFrameElement>(
            `${active} iframe.html-page-viewer__frame`,
          )?.contentDocument;
          return doc?.URL === "about:srcdoc" && doc.readyState === "interactive";
        }, ACTIVE),
      { timeoutMsg: "the page did not reach the state between parsing and loading" },
    );
    await test();
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

interface MovedFrame {
  /** The file that the moved tab shows. */
  file: string | null;
  inWindow: boolean;
  /** Whether the frame shows the copy again, in a new document, with its text parsed. */
  again: boolean;
  readyState: string | null;
  inert: boolean;
}

/** What the tab that moveActiveTab moved shows, in whichever window it is. */
async function movedFrame(): Promise<MovedFrame | null> {
  return browser.executeObsidian(({ app }) => {
    const found: MovedFrame[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const frame = leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe");
      if (frame?.dataset.e2eMoved === undefined) return;
      const doc = frame.contentDocument;
      found.push({
        file: (leaf.view as { file?: { path: string } | null }).file?.path ?? null,
        inWindow: frame.ownerDocument !== document,
        again:
          doc?.URL === "about:srcdoc" &&
          doc.documentElement?.dataset.e2eBefore === undefined &&
          doc.getElementById("vault") !== null,
        readyState: doc?.readyState ?? null,
        inert: doc?.documentElement?.hasAttribute("inert") ?? false,
      });
    });
    return found[0] ?? null;
  });
}

/**
 * Waits until the moved frame shows its page again and the view watches it,
 * which lets the page act, and checks that the page has not loaded yet.
 */
async function waitForMovedPage(): Promise<void> {
  let state: MovedFrame | null = null;
  await browser.waitUntil(
    async () => {
      state = await movedFrame();
      return state?.again === true && !state.inert;
    },
    { timeout: 5000, timeoutMsg: "the view did not watch the moved page before it loaded" },
  );
  expect(state).toMatchObject({ readyState: "interactive" });
}

/** The tab that the tests of where a link opens show the page in. */
const PAGE_TAB = '.workspace-leaf[data-e2e-tab="page"]';

/**
 * Marks the active tab, which shows a page, for `PAGE_TAB` and `shownTabs`,
 * and pins it if asked.
 */
async function markPageTab(pinned = false): Promise<void> {
  await browser.executeObsidian(({ app }, pinned) => {
    const page = app.workspace.getMostRecentLeaf()!;
    page.view.containerEl.closest<HTMLElement>(".workspace-leaf")!.dataset.e2eTab = "page";
    if (pinned) page.setPinned(true);
  }, pinned);
}

/**
 * Waits until the page's tab, in whichever window it is, shows the page again
 * after a move, and the view watches it, so that its links work.
 */
async function waitForPageInTab(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }) => {
        let ready = false;
        app.workspace.iterateAllLeaves((leaf) => {
          const tab = leaf.view.containerEl.closest<HTMLElement>(".workspace-leaf");
          if (tab?.dataset.e2eTab !== "page") return;
          const doc = tab.querySelector<HTMLIFrameElement>(
            "iframe.html-page-viewer__frame",
          )?.contentDocument;
          ready =
            doc?.URL === "about:srcdoc" &&
            doc.documentElement.dataset.e2eBefore === undefined &&
            doc.readyState === "complete" &&
            !doc.documentElement.hasAttribute("inert") &&
            doc.querySelector('a[href="Other%20page.html"]') !== null;
        });
        return ready;
      }),
    { timeoutMsg: "the page's tab did not show its page again" },
  );
}

/**
 * Opens `Saved/Example article.html` in the active tab, pinned if asked, and a
 * note in a tab of a new tab group beside it, which becomes Obsidian's active
 * tab, as when the reader last worked in the note. Splitting moves the page's
 * tab, whose frame then shows the page again.
 */
async function pageBesideActiveNote(pinned = false): Promise<void> {
  await openInActiveTab("Saved/Example article.html");
  await waitForPage();
  await markPageTab(pinned);
  await browser.executeObsidian(async ({ app }) => {
    const note = app.workspace.getLeaf("split", "vertical");
    note.view.containerEl.closest<HTMLElement>(".workspace-leaf")!.dataset.e2eTab = "note";
    await note.openFile(app.vault.getAbstractFileByPath("Notes/Topic.md") as never);
    app.workspace.setActiveLeaf(note, { focus: true });
  });
  await waitForPageInTab();
}

interface ShownTab {
  /** The mark that the test gave the tab, if any. */
  tab: string | null;
  file: string | null;
  /** The tab's tab group, numbered in the order in which Obsidian lists the tabs. */
  group: number;
  inWindow: boolean;
}

/** What each tab outside the sidebars shows, also in other windows, in Obsidian's order. */
async function shownTabs(): Promise<ShownTab[]> {
  return browser.executeObsidian(({ app }) => {
    const groups: unknown[] = [];
    const shown: ShownTab[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const root = leaf.getRoot();
      if (root === app.workspace.leftSplit || root === app.workspace.rightSplit) return;
      if (!groups.includes(leaf.parent)) groups.push(leaf.parent);
      const tab = leaf.view.containerEl.closest<HTMLElement>(".workspace-leaf");
      shown.push({
        tab: tab?.dataset.e2eTab ?? null,
        file: (leaf.view as { file?: { path: string } | null }).file?.path ?? null,
        group: groups.indexOf(leaf.parent),
        inWindow: leaf.view.containerEl.ownerDocument !== document,
      });
    });
    return shown;
  });
}

/** Waits until a tab shows `file`, and returns what each tab shows then. */
async function waitForTabShowing(file: string): Promise<ShownTab[]> {
  let tabs: ShownTab[] = [];
  try {
    await browser.waitUntil(async () => {
      tabs = await shownTabs();
      return tabs.some((each) => each.file === file);
    });
  } catch {
    throw new Error(`No tab showed ${file}: ${JSON.stringify(tabs)}`);
  }
  return tabs;
}

/** Closes the tabs in windows other than Obsidian's main window, which closes those windows. */
async function closeOtherWindows(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    const away: { detach(): void }[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.containerEl.ownerDocument !== document) away.push(leaf);
    });
    for (const leaf of away) leaf.detach();
  });
}

describe("Links in a page in Obsidian", function () {
  beforeEach(async function () {
    await restoreWindowOpen();
    await browser.executeObsidian(({ app }) => {
      // A link's file read can finish after its click test. Never reuse that leaf (#111).
      const fresh = app.workspace.getLeaf("tab");
      app.workspace.setActiveLeaf(fresh, { focus: true });
      const old: (typeof fresh)[] = [];
      app.workspace.iterateRootLeaves((leaf) => {
        if (leaf !== fresh) old.push(leaf);
      });
      for (const leaf of old) leaf.detach();
    });
  });

  it("handles SVG references and empty fragments without reopening the page", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await recordWindowOpen();
    const beforeScroll = await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
      doc.body.insertAdjacentHTML(
        "beforeend",
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a id="svg-web" href="https://example.com/svg"><text>web</text></a><a id="svg-note" xlink:href="../Notes/Topic.md"><text>note</text></a></svg><a id="empty" href="#">top</a>`,
      );
      (doc.querySelector("#svg-web text") as Element).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      doc.documentElement.dataset.e2e = "retained";
      doc.defaultView!.scrollTo(0, 1000);
      const beforeScroll = doc.defaultView!.scrollY;
      doc
        .querySelector("#empty")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return beforeScroll;
    }, ACTIVE);
    expect(beforeScroll).toBeGreaterThan(0);
    expect(await openedUrls()).toEqual(["https://example.com/svg"]);
    expect(
      await browser.execute((active) => {
        const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
        return [doc.documentElement.dataset.e2e, doc.defaultView!.scrollY];
      }, ACTIVE),
    ).toEqual(["retained", 0]);
    await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
      doc
        .querySelector("#svg-note")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, ACTIVE);
    await browser.waitUntil(async () => (await activeFile()).path === "Notes/Topic.md");
  });

  it("intercepts outer links around reference-free HTML and SVG anchors", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await recordWindowOpen();
    const prevented = await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
      doc.body.insertAdjacentHTML(
        "beforeend",
        `<a href="https://example.com/html"><table><tr><td><a id="nested" name="x">text</a></td></tr></table></a><a href="https://example.com/svg"><svg><a><text id="svg-nested">text</text></a></svg></a>`,
      );
      return ["nested", "svg-nested"].map((id) => {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        doc.getElementById(id)!.dispatchEvent(event);
        return event.defaultPrevented;
      });
    }, ACTIVE);
    expect(prevented).toEqual([true, true]);
    expect(await openedUrls()).toEqual(["https://example.com/html", "https://example.com/svg"]);
    expect(await frameLocation()).toBe("about:srcdoc");
  });

  for (const [title, selector] of [
    ["a link in an open shadow root", "#open"],
    ["a link in a closed shadow root", "#closed"],
    ["a link in a closed shadow root inside an open one", "#nested"],
    ["a shadow root's link around the page's own text", "#slotted"],
  ] as const) {
    it(`follows ${title} in the viewer`, async function () {
      await openInActiveTab("Saved/Shadow links.html");
      await waitForPage();
      await clickInPage(selector);
      await browser.waitUntil(async () => (await activeFile()).path === "Saved/Other page.html", {
        timeoutMsg: `${title} did not open its page`,
      });
    });
  }

  it("opens a link in a shadow root declared as `shadowroot` where Chromium reads it", async function () {
    await openInActiveTab("Saved/Shadow links.html");
    await waitForPage();
    // Chromium read the attribute's earlier name until version 119: Chromium
    // 114, in Obsidian 1.5.3's installer, attaches the shadow root, and later
    // versions leave the template as it is, which shows nothing.
    const declared = await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
      const host = doc.getElementById("legacy")!;
      return {
        chromium: Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1]),
        shown: host.getBoundingClientRect().height > 0,
        template: host.querySelector(":scope > template") !== null,
      };
    }, ACTIVE);
    const attached = declared.chromium < 119;
    expect({ shown: declared.shown, template: declared.template }).toEqual({
      shown: attached,
      template: !attached,
    });
    if (!attached) return;
    await clickInPage("#legacy");
    await browser.waitUntil(async () => (await activeFile()).path === "Saved/Other page.html", {
      timeoutMsg: "the link in the shadow root did not open its page",
    });
  });

  it("keeps the page in the frame when a click on a link escapes the view's listeners", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    // A closed shadow root that the page does not declare, as only a script
    // could attach one, hides its link from the view's listeners.
    await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
      const host = doc.createElement("div");
      host.id = "hidden";
      doc.body.prepend(host);
      host.attachShadow({ mode: "closed" }).innerHTML =
        `<p><a href="Other%20page.html">A link that the listeners cannot see</a></p>`;
    }, ACTIVE);
    await recordNavigations();
    await clickInPage("#hidden");
    const started = await startedNavigations();
    expect(started.map(({ url }) => new URL(url).pathname.split("/").at(-1))).toEqual([
      "Other%20page.html",
    ]);
    expect(started.map(({ canceled }) => canceled)).toEqual([true]);
    expect(await frameLocation()).toBe("about:srcdoc");
    expect((await activeFile()).path).toBe("Saved/Long page.html");
  });

  it("keeps the page in the frame when a link copied by SVG `use` is clicked", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    // The copy is in the browser's own shadow tree, whose insides no event
    // path shows, so the view cannot tell which link was clicked.
    await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
      doc.body.insertAdjacentHTML(
        "afterbegin",
        `<svg width="200" height="40"><defs><a id="sprite" href="Other%20page.html"><rect width="200" height="40" fill="green"/></a></defs><use id="copied" href="#sprite"/></svg>`,
      );
    }, ACTIVE);
    await recordNavigations();
    await clickInPage("#copied");
    const started = await startedNavigations();
    expect(started.map(({ canceled }) => canceled)).toEqual([true]);
    expect(await frameLocation()).toBe("about:srcdoc");
    expect((await activeFile()).path).toBe("Saved/Long page.html");
  });

  it("leaves a copy of the frame that the view does not watch unable to act", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    // While a tab is dragged, Obsidian shows a copy of the tab group under the
    // pointer, frames included, which loads the page's copy without the view.
    await browser.execute((active) => {
      const frame = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!;
      const copy = frame.cloneNode() as HTMLIFrameElement;
      copy.id = "e2e-unwatched";
      copy.style.cssText =
        "position: fixed; left: 0; top: 0; width: 600px; height: 400px; z-index: 10000;";
      document.body.append(copy);
    }, ACTIVE);
    try {
      await browser.waitUntil(async () =>
        browser.execute(() => {
          const doc = document.querySelector<HTMLIFrameElement>("#e2e-unwatched")?.contentDocument;
          return doc?.URL === "about:srcdoc" && doc.readyState === "complete";
        }),
      );
      await recordNavigations("#e2e-unwatched");
      const point = await browser.execute(() => {
        const copy = document.querySelector<HTMLIFrameElement>("#e2e-unwatched")!;
        const link = copy.contentDocument!.querySelector('a[href="Other%20page.html"]')!;
        link.scrollIntoView({ block: "center" });
        const outer = copy.getBoundingClientRect();
        const inner = link.getBoundingClientRect();
        return {
          x: Math.round(outer.left + inner.left + 4),
          y: Math.round(outer.top + inner.top + inner.height / 2),
        };
      });
      // The copy is inert, so a click on its link follows nothing. Once it can
      // act, as the view lets a page that it watches act, the same click
      // starts a navigation that nothing cancels, since the copy has none of
      // the view's listeners. Navigations start in the order of their clicks.
      await browser.action("pointer").move(point).down().up().perform();
      expect(await recordedNavigations()).toEqual([]);
      await browser.execute(() => {
        const doc = document.querySelector<HTMLIFrameElement>("#e2e-unwatched")!.contentDocument!;
        doc.documentElement.removeAttribute("inert");
      });
      await browser.action("pointer").move(point).down().up().perform();
      const started = await startedNavigations();
      expect(started.map(({ canceled }) => canceled)).toEqual([false]);
      expect((await activeFile()).path).toBe("Saved/Example article.html");
    } finally {
      await browser.execute(() => document.querySelector("#e2e-unwatched")?.remove());
    }
  });

  it("opens a web link outside Obsidian and keeps the page in the frame", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    await recordWindowOpen();
    await clickInPage('a[href^="https://"]');
    await browser.pause(500);
    expect(await openedUrls()).toEqual(["https://example.com/article"]);
    expect(await frameLocation()).toBe("about:srcdoc");
  });

  it("opens a saved page it links to in the viewer, in the same tab", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    await clickInPage('a[href="Other%20page.html"]');
    await browser.waitUntil(async () => (await activeFile()).path === "Saved/Other page.html", {
      timeoutMsg: "the linked page did not open",
    });
    expect((await activeFile()).type).toBe(VIEW_TYPE);
  });

  it("opens a note it links to as a note", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    await clickInPage('a[href="../Notes/Topic.md"]');
    await browser.waitUntil(async () => (await activeFile()).path === "Notes/Topic.md", {
      timeoutMsg: "the linked note did not open",
    });
    expect((await activeFile()).type).toBe("markdown");
  });

  it("opens a note that a link names by file name only", async function () {
    await openInActiveTab("Saved/By name.html");
    await waitForPage();
    await clickInPage('a[href="Topic.md"]');
    await browser.waitUntil(async () => (await activeFile()).path === "Notes/Topic.md", {
      timeoutMsg: "the note named by the link did not open",
    });
  });

  it("opens a link in a new tab with Ctrl", async function () {
    await openInActiveTab("Mirror/index.html");
    await waitForPage();
    const tabs = async () =>
      browser.executeObsidian(({ app }) => {
        let count = 0;
        app.workspace.iterateRootLeaves(() => {
          count += 1;
        });
        return count;
      });
    const expected = await browser.executeObsidian(async ({ app }) =>
      app.vault.read(app.vault.getAbstractFileByPath("Mirror/about.html") as never),
    );
    const shown = async () =>
      browser.executeObsidian(({ app }, expected) => {
        let found = false;
        app.workspace.iterateRootLeaves((leaf) => {
          const view = leaf.view as unknown as {
            file?: { path: string } | null;
            getViewData?: () => string;
          };
          if (view.file?.path === "Mirror/about.html" && view.getViewData?.() === expected)
            found = true;
        });
        return found;
      }, expected);
    const before = await tabs();
    await clickInPage('a[href="about.html"]', [CONTROL]);
    // file is assigned before vault.read finishes; data proves setViewData has run (#111).
    await browser.waitUntil(async () => (await tabs()) === before + 1 && (await shown()), {
      timeoutMsg: "no new tab opened Mirror/about.html",
    });
  });

  // A click in a page reaches only the page's own document, so it never makes
  // its tab Obsidian's active one, which Obsidian opens links from (#141).
  it("opens a link in its own tab while a tab in another tab group is active (#141)", async function () {
    await pageBesideActiveNote();
    await clickInPage('a[href="Other%20page.html"]', [], PAGE_TAB);
    expect(await waitForTabShowing("Saved/Other page.html")).toEqual([
      { tab: "page", file: "Saved/Other page.html", group: 0, inWindow: false },
      { tab: "note", file: "Notes/Topic.md", group: 1, inWindow: false },
    ]);
  });

  it("opens a link in a new tab beside its own with Ctrl while a tab in another tab group is active (#141)", async function () {
    await pageBesideActiveNote();
    await clickInPage('a[href="Other%20page.html"]', [CONTROL], PAGE_TAB);
    expect(await waitForTabShowing("Saved/Other page.html")).toEqual([
      { tab: "page", file: "Saved/Example article.html", group: 0, inWindow: false },
      { tab: null, file: "Saved/Other page.html", group: 0, inWindow: false },
      { tab: "note", file: "Notes/Topic.md", group: 1, inWindow: false },
    ]);
  });

  // Obsidian opens a link from a pinned tab, as from a pinned note, in the
  // tab that was active most recently among those not pinned.
  it("keeps a pinned tab's page and opens its link where a pinned note's link opens (#141)", async function () {
    await pageBesideActiveNote(true);
    await clickInPage('a[href="Other%20page.html"]', [], PAGE_TAB);
    expect(await waitForTabShowing("Saved/Other page.html")).toEqual([
      { tab: "page", file: "Saved/Example article.html", group: 0, inWindow: false },
      { tab: "note", file: "Saved/Other page.html", group: 1, inWindow: false },
    ]);
  });

  for (const ctrl of [false, true]) {
    it(`opens a link ${ctrl ? "in a new tab beside its own with Ctrl" : "in its own tab"} in a new window while the main window's tab is active (#141)`, async function () {
      await openInActiveTab("Saved/Example article.html");
      await waitForPage();
      await markPageTab();
      try {
        await moveActiveTab("window");
        await waitForPageInTab();
        // WebDriver drives Obsidian's main window, so the click is dispatched
        // in the page, where the view's listeners treat it as any click.
        await browser.executeObsidian(({ app }, ctrl) => {
          // The empty tab that Obsidian leaves in the main window.
          const main = app.workspace
            .getLeavesOfType("empty")
            .find((leaf) => leaf.view.containerEl.ownerDocument === document);
          app.workspace.setActiveLeaf(main!, { focus: true });
          // Obsidian, 1.5.3 and 1.15.1 alike, opens a new tab in the tab group
          // of the tab that became active last by Date.now(), and in the main
          // window's on a tie, so the click comes in a later millisecond, as a
          // reader's does: the view makes its tab active at the click (#141).
          const activated = Date.now();
          while (Date.now() === activated) {
            // The next millisecond.
          }
          app.workspace.iterateAllLeaves((leaf) => {
            const tab = leaf.view.containerEl.closest<HTMLElement>(".workspace-leaf");
            if (tab?.dataset.e2eTab !== "page") return;
            tab
              .querySelector<HTMLIFrameElement>("iframe.html-page-viewer__frame")!
              .contentDocument!.querySelector('a[href="Other%20page.html"]')!
              .dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: ctrl }),
              );
          });
        }, ctrl);
        expect(await waitForTabShowing("Saved/Other page.html")).toEqual([
          { tab: null, file: null, group: 0, inWindow: false },
          ...(ctrl
            ? [
                { tab: "page", file: "Saved/Example article.html", group: 1, inWindow: true },
                { tab: null, file: "Saved/Other page.html", group: 1, inWindow: true },
              ]
            : [{ tab: "page", file: "Saved/Other page.html", group: 1, inWindow: true }]),
        ]);
      } finally {
        await closeOtherWindows();
      }
    });
  }

  it("scrolls to a part of the page", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await browser.execute(() => {
      document
        .querySelector(".workspace-leaf.mod-active iframe.html-page-viewer__frame")
        ?.setAttribute("data-e2e-marker", "");
    });
    const attempts = await clickInPage('a[href="#end"]');
    await browser.pause(500);
    const after = await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>(
        ".workspace-leaf.mod-active iframe.html-page-viewer__frame",
      );
      const end = frame?.contentDocument?.getElementById("end")?.getBoundingClientRect();
      const height = frame?.contentWindow?.innerHeight ?? 0;
      let location = "cross-origin";
      try {
        location = frame?.contentWindow?.location.href ?? "none";
      } catch {
        // A frame that navigated away is cross-origin.
      }
      return {
        sameFrame: frame?.hasAttribute("data-e2e-marker") ?? false,
        endInView: end !== undefined && end.top >= 0 && end.top < height,
        detail: {
          location,
          scrollY: frame?.contentWindow?.scrollY ?? null,
          endTop: end?.top ?? null,
          height,
        },
      };
    });
    expect({
      sameFrame: after.sameFrame,
      endInView: after.endInView,
      attempts,
      detail: after.detail,
    }).toEqual({
      sameFrame: true,
      endInView: true,
      attempts,
      detail: after.detail,
    });
    expect(await frameLocation()).toBe("about:srcdoc");
  });

  it("refuses a link outside the vault", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await clickInPage('a[href="../../outside.html"]');
    const notice = await browser.$(
      ".notice=This link leads outside the vault, so it was not opened.",
    );
    await notice.waitForExist();
    expect(await frameLocation()).toBe("about:srcdoc");
    expect((await activeFile()).path).toBe("Saved/Long page.html");
  });

  it("follows a link clicked while the page is still loading (#31)", async function () {
    await withPageStillLoading(
      `<p><a href="https://example.com/still-loading">A web link</a></p>`,
      async () => {
        await recordWindowOpen();
        await clickInPage('a[href^="https://"]');
        await browser.pause(500);
        expect(await openedUrls()).toEqual(["https://example.com/still-loading"]);
        expect(await frameLocation()).toBe("about:srcdoc");
      },
    );
  });

  it("follows a link as soon as its tab moves to another tab group, before the page loads again", async function () {
    await withPageStillLoading(
      `<p><a id="vault" href="Other%20page.html">Another saved page</a></p>`,
      async () => {
        await moveActiveTab("group");
        await waitForMovedPage();
        await clickInPage("#vault");
        await browser.waitUntil(async () => (await activeFile()).path === "Saved/Other page.html", {
          timeoutMsg: "the link did not open its page",
        });
        expect(await frameLocation()).toBe("about:srcdoc");
      },
    );
  });

  it("follows a link as soon as its tab moves to a new window, before the page loads again", async function () {
    await withPageStillLoading(
      `<p><a id="vault" href="Other%20page.html">Another saved page</a></p>`,
      async () => {
        try {
          await moveActiveTab("window");
          await waitForMovedPage();
          expect(await movedFrame()).toMatchObject({ inWindow: true });
          // WebDriver drives Obsidian's main window, so the click is dispatched
          // in the page, where the view's listeners treat it as any click.
          const canceled = await browser.executeObsidian(({ app }) => {
            const results: boolean[] = [];
            app.workspace.iterateAllLeaves((leaf) => {
              const frame =
                leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe[data-e2e-moved]");
              const link = frame?.contentDocument?.getElementById("vault");
              if (!link) return;
              const event = new MouseEvent("click", { bubbles: true, cancelable: true });
              link.dispatchEvent(event);
              results.push(event.defaultPrevented);
            });
            return results;
          });
          expect(canceled).toEqual([true]);
          // The view opens the link in the moved tab, in a new frame.
          await browser.waitUntil(
            async () =>
              browser.executeObsidian(({ app }) => {
                let shown = false;
                app.workspace.iterateAllLeaves((leaf) => {
                  const file = (leaf.view as { file?: { path: string } | null }).file?.path;
                  if (leaf.view.containerEl.ownerDocument !== document)
                    shown ||= file === "Saved/Other page.html";
                });
                return shown;
              }),
            { timeoutMsg: "the link did not open its page in the new window" },
          );
        } finally {
          await closeOtherWindows();
        }
      },
    );
  });

  it("shows where each link leads, and an image's alt text, on hover (#42)", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    const shown = await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(
        `${active} iframe.html-page-viewer__frame`,
      )?.contentDocument;
      return {
        links: [...(doc?.querySelectorAll("a") ?? [])].map((link) => [
          link.textContent,
          link.getAttribute("title"),
        ]),
        images: [...(doc?.images ?? [])].map((image) => image.getAttribute("title")),
      };
    }, ACTIVE);
    expect(shown.links).toEqual([
      ["example.com", "https://example.com/article"],
      ["another saved page", "Saved/Other page.html"],
      ["Topic", "Notes/Topic.md"],
      ["the details", null],
    ]);
    expect(shown.images).toEqual(["A green square"]);

    // With scripts on, the view cannot reach the page, but the copy it shows has the titles.
    await clickToolbarButton("Scripts OFF");
    try {
      const titled = await browser.execute((active) => {
        const srcdoc =
          document.querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`)
            ?.srcdoc ?? "";
        return (
          new DOMParser()
            .parseFromString(srcdoc, "text/html")
            .querySelector("a")
            ?.getAttribute("title") ?? null
        );
      }, ACTIVE);
      expect(titled).toBe("https://example.com/article");
    } finally {
      await clickToolbarButton("Scripts ON");
    }
  });

  it("shows where links in shadow roots and SVG links lead on hover (#117, #124)", async function () {
    const SVG_LINKS = ["shape", "legacy", "text", "own", "labelled", "icon", "own-label", "html"];
    await openInActiveTab("Saved/Link titles.html");
    await waitForPage();
    const shown = await browser.execute(
      (active, ids) => {
        const doc = document.querySelector<HTMLIFrameElement>(
          `${active} iframe.html-page-viewer__frame`,
        )!.contentDocument!;
        // The copy declares the page's closed shadow root open.
        const shadow = doc.getElementById("shadow")!.shadowRoot!;
        return {
          shadow: [
            shadow.querySelector("a")?.getAttribute("title"),
            shadow.querySelector("img")?.getAttribute("title"),
          ],
          // Chromium shows an SVG link's xlink:title, or else its <title> child, never a title attribute.
          svg: ids.map((id) => {
            const link = doc.getElementById(id)!;
            return [id, link.getAttributeNS("http://www.w3.org/1999/xlink", "title")];
          }),
          titleAttributes: doc.querySelectorAll("svg [title]").length,
        };
      },
      ACTIVE,
      SVG_LINKS,
    );
    // Chromium also reads an SVG link's tooltip as its name, before the name
    // its content gives it, so a link whose text, labelled shape, icon, or
    // HTML content names it gets no tooltip. A link's own label comes before
    // the tooltip. Obsidian 1.5.3 and 1.15.1 name an SVG link from nothing in
    // a <foreignObject>, so the link around HTML has no name there, but Chrome
    // 157 names it by its shadow root's text; either way, not by the tooltip.
    await browser.switchFrame(browser.$(`${ACTIVE} iframe.html-page-viewer__frame`));
    const names: string[] = [];
    try {
      names.push(await browser.$("#shadow").shadow$("a").getComputedLabel());
      for (const id of SVG_LINKS) names.push(await browser.$(`#${id}`).getComputedLabel());
    } finally {
      await browser.switchFrame(null);
    }
    expect({ ...shown, names }).toEqual({
      shadow: ["Saved/Other page.html", "A green square, in a shadow root"],
      svg: [
        ["shape", "https://example.com/shape"],
        ["legacy", "Saved/Other page.html"],
        ["text", null],
        ["own", null],
        ["labelled", null],
        ["icon", null],
        ["own-label", "https://example.com/own-label"],
        ["html", null],
      ],
      titleAttributes: 0,
      names: [
        "Another saved page, from a shadow root",
        "https://example.com/shape",
        "Saved/Other page.html",
        "An SVG link with text",
        "The page's own title",
        "A shape with a label",
        "An icon with its own title",
        "A link with its own label",
        expect.not.stringContaining("example.com"),
      ],
    });
  });

  describe("whose href starts or ends with a space (#199)", function () {
    // HTML strips only ASCII whitespace from a link's href, and keeps a
    // no-break space, which JavaScript's trim would also take. A file is
    // named with one before its name, and a decoy without it.
    const nbsp = String.fromCodePoint(0xa0);
    const PAGE = "Saved/Spaced links.html";
    const TARGET = `Saved/${nbsp}Spaced target.html`;
    const DECOY = "Saved/Spaced target.html";

    before(async function () {
      await browser.executeObsidian(
        async ({ app }, page, decoy, target) => {
          await app.vault.create(
            page,
            `<!doctype html><meta charset="utf-8"><title>Spaced links</title>` +
              `<p><a id="nbsp" href="&nbsp;Spaced%20target.html">with a no-break space</a></p>` +
              `<p><a id="ascii" href="&#10; Spaced%20target.html&#9;">with ASCII whitespace</a></p>`,
          );
          await app.vault.create(decoy, "<p>The decoy, without the no-break space</p>");
          // Obsidian's API names a file that it creates with a space for
          // U+00A0, so this one is written as a sync tool would.
          const adapter = app.vault.adapter as unknown as {
            write(path: string, data: string): Promise<void>;
          };
          await adapter.write(target, "<p>The target, with the no-break space</p>");
        },
        PAGE,
        DECOY,
        TARGET,
      );
      await browser.waitUntil(
        () =>
          browser.executeObsidian(
            ({ app }, target) => app.vault.getAbstractFileByPath(target) !== null,
            TARGET,
          ),
        { timeout: 10_000, timeoutMsg: "the vault did not list the file written by its name" },
      );
    });

    after(async function () {
      await browser.executeObsidian(
        async ({ app }, paths) => {
          for (const path of paths) {
            const file = app.vault.getAbstractFileByPath(path);
            if (file) await app.vault.delete(file);
          }
        },
        [PAGE, DECOY, TARGET],
      );
    });

    it("names in its tooltip the file that Chromium resolves it to, which a click opens", async function () {
      await openInActiveTab(PAGE);
      await waitForPage();
      const vaultUrl = await browser.executeObsidian(({ app }, page) => {
        const file = app.vault.getAbstractFileByPath(page);
        return new URL("../", app.vault.getResourcePath(file as never)).href;
      }, PAGE);
      const shown = await browser.execute(
        (active, vaultUrl) => {
          const doc = document.querySelector<HTMLIFrameElement>(
            `${active} iframe.html-page-viewer__frame`,
          )!.contentDocument!;
          return ["nbsp", "ascii"].map((id) => {
            const link = doc.getElementById(id) as HTMLAnchorElement;
            // Chromium's own resolution of the link, as a vault path.
            const resolved = decodeURIComponent(link.href.slice(vaultUrl.length));
            return [id, link.getAttribute("title"), resolved];
          });
        },
        ACTIVE,
        vaultUrl,
      );
      expect(shown).toEqual([
        ["nbsp", TARGET, TARGET],
        ["ascii", DECOY, DECOY],
      ]);
      await clickInPage("#nbsp");
      await browser.waitUntil(async () => (await activeFile()).path === TARGET, {
        timeoutMsg: "the link did not open the file of the name with the no-break space",
      });
    });
  });
});
