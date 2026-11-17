// The viewer extends Obsidian's TextFileView, whose saving writes the view's
// data to its file when the file leaves the view: when another file opens in
// the tab, or the view closes or gives way to another view. These tests check,
// in Obsidian, that no such write happens, even after a refresh that the view
// moved on from while it read the file (#90). A refresh's read is held until
// the test completes it, so the order of events is the test's, not timing's.
// Each test moves the view to a file of its own, so that a write that one
// test finds does not decide the next one's result.

import fs from "node:fs";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import {
  ACTIVE,
  activeViewType,
  openInActiveTab,
  vaultFolder,
  VIEW_TYPE,
  waitForPage,
} from "../support/viewer.ts";

const FIRST = "Read only/First page.html";
const SECOND = "Read only/Second page.html";
const THIRD = "Read only/Third page.html";
const fixture = (file: string): string =>
  fs.readFileSync(path.join(import.meta.dirname, "..", "vaults", "pages", file), "utf8");

/** What the tests keep in Obsidian's window. */
interface Held {
  /** The view under test, kept to see when it has let go of its file. */
  e2eView?: { file: unknown; getViewData(): string; contentEl: HTMLElement };
  /** Completes the held read: with the file's contents, the given contents, or an error. */
  e2eRelease?: (outcome: { data?: string; error?: string }) => Promise<void>;
  /** The paths that `vault.modify` was asked to write. */
  e2eWrites?: string[];
  e2eModify?: unknown;
}

/** Records the active view, and every `vault.modify` from now on. */
async function watchActiveView(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    const held = window as unknown as Held;
    held.e2eView = app.workspace.getMostRecentLeaf()?.view as Held["e2eView"];
    held.e2eWrites = [];
    const vault = app.vault as unknown as {
      modify(file: { path: string }, data: string): Promise<void>;
    };
    if (held.e2eModify === undefined) {
      const modify = vault.modify;
      held.e2eModify = modify;
      vault.modify = function (file, data) {
        held.e2eWrites?.push(file.path);
        return modify.call(this, file, data);
      };
    }
  });
}

/** Holds Obsidian's next read of `filePath` until the test calls {@link release}. */
async function holdNextRead(filePath: string): Promise<void> {
  await browser.executeObsidian(({ app }, filePath) => {
    const held = window as unknown as Held;
    const vault = app.vault as unknown as {
      read(file: { path: string }): Promise<string>;
    };
    const read = vault.read;
    vault.read = function (file) {
      if (file.path !== filePath) return read.call(this, file);
      delete (vault as { read?: unknown }).read;
      const contents = read.call(this, file);
      return new Promise<string>((resolve, reject) => {
        held.e2eRelease = async ({ data, error }) => {
          if (error !== undefined) reject(new Error(error));
          else resolve(data ?? (await contents));
          // The view continues from the read before this does.
          await contents.catch(() => undefined);
          await new Promise((settled) => setTimeout(settled, 0));
        };
      });
    };
  }, filePath);
}

async function release(outcome: { data?: string; error?: string } = {}): Promise<void> {
  await browser.executeObsidian(async (_obsidian, outcome) => {
    const held = window as unknown as Held;
    if (!held.e2eRelease) throw new Error("The view did not read the held file");
    await held.e2eRelease(outcome);
    delete held.e2eRelease;
  }, outcome);
}

async function refresh(): Promise<void> {
  await browser
    .$(`${ACTIVE} .html-page-viewer__toolbar button[aria-label="Refresh preview"]`)
    .click();
}

/** Waits until the watched view has let go of its file, after any save Obsidian makes then. */
async function waitForUnload(): Promise<void> {
  await browser.waitUntil(
    async () => browser.execute(() => (window as unknown as Held).e2eView?.file === null),
    { timeoutMsg: "the view kept its file" },
  );
}

/** What the watched view holds and shows: its data, its title, its message, and its page's text. */
async function shown(): Promise<{
  data: string | null;
  title: string | null;
  message: string | null;
  page: string | null;
}> {
  return browser.execute(() => {
    const view = (window as unknown as Held).e2eView;
    const content = view?.contentEl;
    const doc = content?.querySelector<HTMLIFrameElement>(
      "iframe.html-page-viewer__frame",
    )?.contentDocument;
    return {
      data: view?.getViewData() ?? null,
      title: content?.querySelector(".html-page-viewer__filename")?.textContent ?? null,
      message: content?.querySelector(".html-page-viewer__message")?.textContent ?? null,
      page: doc?.body?.textContent?.trim() ?? null,
    };
  });
}

async function onDisk(file: string): Promise<string> {
  return fs.readFileSync(path.join(await vaultFolder(), file), "utf8");
}

async function writes(): Promise<string[]> {
  return browser.execute(() => (window as unknown as Held).e2eWrites ?? []);
}

describe("The viewer never writes the files it shows", function () {
  beforeEach(async function () {
    await openInActiveTab(FIRST);
    expect(await activeViewType()).toBe(VIEW_TYPE);
    await waitForPage();
    await watchActiveView();
  });

  afterEach(async function () {
    // Restore Obsidian's own read, in case a test failed before it was used.
    await browser.executeObsidian(({ app }) => {
      delete (app.vault as { read?: unknown }).read;
    });
  });

  it("refreshes the page, and leaves the file as it is when the tab opens a note", async function () {
    await browser.execute(() => {
      const view = (window as unknown as Held).e2eView;
      view?.contentEl.querySelector("iframe")?.setAttribute("data-e2e-before", "");
    });
    await refresh();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const frame = (window as unknown as Held).e2eView?.contentEl.querySelector("iframe");
          return frame !== null && frame !== undefined && !frame.hasAttribute("data-e2e-before");
        }),
      { timeoutMsg: "the refresh did not replace the page" },
    );
    await waitForPage();
    expect((await shown()).page).toBe("first original");

    // As when the file changed on disk without Obsidian noticing: the refresh
    // reads contents that Obsidian did not load.
    await holdNextRead(FIRST);
    await refresh();
    await release({ data: "<p>first, changed on disk</p>" });
    await waitForPage();
    expect((await shown()).data).toBe("<p>first, changed on disk</p>");

    await openInActiveTab("Notes/Topic.md");
    await waitForUnload();
    expect(await writes()).toEqual([]);
    expect(await onDisk(FIRST)).toBe(fixture(FIRST));
  });

  it("ignores a refresh's read that finishes after another file opened in the tab", async function () {
    await holdNextRead(FIRST);
    await refresh();
    await openInActiveTab(SECOND);
    await waitForPage();
    await release();
    const view = await shown();

    await openInActiveTab("Notes/Topic.md");
    await waitForUnload();
    expect(await writes()).toEqual([]);
    expect(await onDisk(SECOND)).toBe(fixture(SECOND));
    expect(await onDisk(FIRST)).toBe(fixture(FIRST));
    expect(view).toEqual({
      data: fixture(SECOND),
      title: "Second page.html",
      message: null,
      page: "second original",
    });
  });

  it("shows the file that the tab shows when Obsidian's reload of a changed file finishes after another opened (#115)", async function () {
    // Obsidian reads a file again when the vault reports that it changed, as
    // when it changes on disk; here the report comes without a change.
    await holdNextRead(FIRST);
    await browser.executeObsidian(({ app }, filePath) => {
      app.vault.trigger("modify", app.vault.getAbstractFileByPath(filePath));
    }, FIRST);
    await openInActiveTab(SECOND);
    await waitForPage();
    await release({ data: "<p>first, changed on disk</p>" });
    // The view reads the file that it shows again.
    await browser.pause(500);
    await waitForPage();
    const view = await shown();

    await openInActiveTab("Notes/Topic.md");
    await waitForUnload();
    expect(await writes()).toEqual([]);
    expect(await onDisk(SECOND)).toBe(fixture(SECOND));
    expect(await onDisk(FIRST)).toBe(fixture(FIRST));
    expect(view).toEqual({
      data: fixture(SECOND),
      title: "Second page.html",
      message: null,
      page: "second original",
    });
  });

  it("shows no error from a refresh whose file the tab has left, and writes nothing on closing", async function () {
    await holdNextRead(FIRST);
    await refresh();
    await openInActiveTab(THIRD);
    await waitForPage();
    await release({ error: "permission denied" });
    const view = await shown();

    await browser.executeObsidian(({ app }) => app.workspace.getMostRecentLeaf()?.detach());
    await waitForUnload();
    expect(await writes()).toEqual([]);
    expect(await onDisk(THIRD)).toBe(fixture(THIRD));
    expect(view).toEqual({
      data: fixture(THIRD),
      title: "Third page.html",
      message: null,
      page: "third original",
    });
  });
});
