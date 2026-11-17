import http from "node:http";
import type { AddressInfo } from "node:net";
import { browser, expect } from "@wdio/globals";
import {
  ACTIVE,
  activeFile,
  clickInPage,
  clickToolbarButton,
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

/** Waits until a click has started a navigation, and returns those recorded. */
async function startedNavigations(): Promise<Navigation[]> {
  const seen = async () =>
    browser.execute(
      () => (window as unknown as { e2eNavigations?: Navigation[] }).e2eNavigations ?? [],
    );
  await browser.waitUntil(async () => (await seen()).length > 0, {
    timeoutMsg: "the click started no navigation",
  });
  return seen();
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

/**
 * Moves the active tab to a new tab group beside it, with the calls that
 * Obsidian makes when a tab is dropped on another tab group, or to a new
 * window, as the tab's menu does. Either way Obsidian moves the tab's
 * elements, and the frame drops its document and loads its copy again.
 */
async function moveActiveTab(to: "group" | "window"): Promise<void> {
  await browser.executeObsidian(({ app }, to) => {
    const leaf = app.workspace.getMostRecentLeaf()!;
    const frame = leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe")!;
    frame.dataset.e2eMoved = "";
    frame.contentDocument!.documentElement.dataset.e2eBefore = "";
    if (to === "window") {
      app.workspace.moveLeafToPopout(leaf);
      return;
    }
    // Not in Obsidian's API types; 1.5.3 and 1.15.1 have them.
    interface Parent {
      children: unknown[];
      removeChild(child: unknown): void;
      insertChild(index: number, child: unknown): void;
      selectTabIndex(index: number): void;
    }
    const moved = leaf as unknown as { parent: Parent; setDimension(size: null): void };
    const split = app.workspace.getLeaf("split", "vertical") as unknown as { parent: Parent };
    moved.parent.removeChild(leaf);
    moved.setDimension(null);
    split.parent.insertChild(-1, leaf);
    split.parent.selectTabIndex(split.parent.children.indexOf(leaf));
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, to);
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
          // Closing the window's tabs closes the window.
          await browser.executeObsidian(({ app }) => {
            const away: { detach(): void }[] = [];
            app.workspace.iterateAllLeaves((leaf) => {
              if (leaf.view.containerEl.ownerDocument !== document) away.push(leaf);
            });
            for (const leaf of away) leaf.detach();
          });
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
});
