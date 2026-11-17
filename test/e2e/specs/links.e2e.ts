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
    const opened: string[] = [];
    (window as unknown as { e2eOpened: string[] }).e2eOpened = opened;
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
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

describe("Links in a page in Obsidian", function () {
  beforeEach(async function () {
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
    // Chromium 114, in Obsidian 1.5.3's installer, attaches the shadow root;
    // later versions leave the template as it is, which shows nothing.
    const declared = await browser.execute((active) => {
      const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
      const host = doc.getElementById("legacy")!;
      return {
        shown: host.getBoundingClientRect().height > 0,
        template: host.querySelector(":scope > template") !== null,
      };
    }, ACTIVE);
    expect(declared.shown).toBe(!declared.template);
    if (!declared.shown) return;
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
    await clickInPage("#hidden");
    await browser.pause(1000);
    expect(await frameLocation()).toBe("about:srcdoc");
    expect((await activeFile()).path).toBe("Saved/Long page.html");
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
    // An image from a server that never answers holds the page's load event
    // back for as long as the test needs.
    const server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await browser.executeObsidian(async ({ app }, port) => {
        const path = "Saved/Still loading.html";
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Still loading</title></head><body><p><a href="https://example.com/still-loading">A web link</a></p><img src="http://127.0.0.1:${port}/never.png" alt="An image that never arrives" width="16" height="16"></body></html>`;
        const existing = app.vault.getAbstractFileByPath(path);
        if (existing) await app.vault.modify(existing as never, html);
        else await app.vault.create(path, html);
      }, port);
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
      await recordWindowOpen();
      await clickInPage('a[href^="https://"]');
      await browser.pause(500);
      expect(await openedUrls()).toEqual(["https://example.com/still-loading"]);
      expect(await frameLocation()).toBe("about:srcdoc");
    } finally {
      server.closeAllConnections();
      server.close();
    }
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
