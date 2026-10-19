import http from "node:http";
import type { AddressInfo } from "node:net";
import { browser, expect } from "@wdio/globals";
import { ACTIVE, activeFile, clickInPage, openInActiveTab, VIEW_TYPE, waitForPage } from "../support/viewer.ts";

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
    const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
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
      // Start each test with one tab.
      app.workspace.iterateAllLeaves((leaf) => {
        if (leaf !== app.workspace.getMostRecentLeaf() && leaf.getRoot() === app.workspace.rootSplit) leaf.detach();
      });
    });
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
    const before = await tabs();
    await clickInPage('a[href="about.html"]', [CONTROL]);
    await browser.waitUntil(async () => (await tabs()) === before + 1, { timeoutMsg: "no new tab opened" });
  });

  it("scrolls to a part of the page", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await clickInPage('a[href="#end"]');
    await browser.pause(500);
    const endInView = await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
      const end = frame?.contentDocument?.getElementById("end")?.getBoundingClientRect();
      const height = frame?.contentWindow?.innerHeight ?? 0;
      return end !== undefined && end.top >= 0 && end.top < height;
    });
    expect(endInView).toBe(true);
    expect(await frameLocation()).toBe("about:srcdoc");
  });

  it("refuses a link outside the vault", async function () {
    await openInActiveTab("Saved/Long page.html");
    await waitForPage();
    await clickInPage('a[href="../../outside.html"]');
    const notice = await browser.$(".notice=This link leads outside the vault, so it was not opened.");
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
            const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`)?.contentDocument;
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
});