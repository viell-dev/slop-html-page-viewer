import fs from "node:fs";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import { type Color, decodePng, solidPng } from "../support/pixels.ts";
import {
  ACTIVE,
  clickToolbarButton,
  framePixels,
  openInActiveTab,
  saveScreenshot,
  vaultFolder,
  waitForPage,
} from "../support/viewer.ts";

// The fixture image's green, and the mirrored site's banner blue.
const GREEN: Color = [46, 125, 50];
const BLUE: Color = [21, 101, 192];
const RED: Color = [198, 40, 40];
const IMAGE_PIXELS = 64 * 64;

describe("A page's local files in Obsidian", function () {
  before(async function () {
    // An image just outside the vault, which a page must not be able to show.
    const outside = path.join(path.dirname(await vaultFolder()), "outside.png");
    fs.writeFileSync(outside, solidPng(64, RED));
  });

  it("shows a saved page's image from the folder beside it", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    await saveScreenshot("example-article-image");
    expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
  });

  it("applies a mirrored site's own stylesheet", async function () {
    await openInActiveTab("Mirror/index.html");
    await waitForPage();
    await saveScreenshot("mirror-stylesheet");
    expect(await framePixels(BLUE)).toBeGreaterThan(1000);
  });

  it("shows an image that the page names by file name only, as Obsidian's links do", async function () {
    await openInActiveTab("Saved/By name.html");
    await waitForPage();
    expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
  });

  it("shows nothing from outside the vault", async function () {
    await openInActiveTab("Saved/Outside reference.html");
    await waitForPage();
    expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
    expect(await framePixels(RED)).toBe(0);
  });

  it("isolates the page from the vault's files while scripts are on", async function () {
    await openInActiveTab("Saved/Example article.html");
    await clickToolbarButton("Scripts OFF");
    await waitForPage();
    // A known limit: with scripts, the page has an opaque origin, which
    // Obsidian does not serve vault files to.
    expect(await framePixels(GREEN)).toBe(0);
    await clickToolbarButton("Scripts ON");
  });

  describe("on a page that preparing could fail on", function () {
    // The same image outside the vault, named by its full address, which
    // only the copy's own policy keeps out.
    let outside = "";

    before(async function () {
      outside = await browser.executeObsidian(({ app }) => {
        const file = app.vault.getAbstractFileByPath("Interactive.html");
        if (file === null) throw new Error("No file at Interactive.html");
        return new URL("../outside.png", app.vault.getResourcePath(file as never)).href;
      });
    });

    afterEach(async function () {
      await restoreHost();
    });

    function page(head: string, body = ""): string {
      return [
        `<!doctype html>`,
        `<html lang="en"><head><meta charset="utf-8"><title>Preparation</title>${head}</head>`,
        `<body><p>An image inside the vault, and one outside it.</p>`,
        `<img src="2026-01-15/figure.png" alt="Inside" width="64" height="64">`,
        `<img src="${outside}" alt="Outside" width="64" height="64">${body}`,
        `</body></html>`,
      ].join("\n");
    }

    it("shows a page whose CSS escape names no character with only the vault's files", async function () {
      await writeVaultFile(
        "Saved/Escape.html",
        page(`<style>p { background: url(\\110000.png) }</style>`),
      );
      await openInActiveTab("Saved/Escape.html");
      await waitForPage();
      await saveScreenshot("escape-past-last-code-point");
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
      expect(await framePixels(RED)).toBe(0);
    });

    it("leaves out a stylesheet that cannot be read, and shows only the vault's files", async function () {
      await writeVaultFile("Saved/Unreadable.css", "p { font-weight: bold }");
      await writeVaultFile(
        "Saved/Unreadable stylesheet.html",
        page(`<link rel="stylesheet" href="Unreadable.css">`),
      );
      await failRead("Saved/Unreadable.css");
      await openInActiveTab("Saved/Unreadable stylesheet.html");
      await waitForPage();
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
      expect(await framePixels(RED)).toBe(0);
    });

    it("shows an error instead of a page it cannot prepare, and the page once it can", async function () {
      const html = page("", `\n<img src="Missing.png" alt="Missing">`);
      await writeVaultFile("Saved/Unprepared.html", html);
      // A host failure that preparing the page cannot work around.
      await failLinkResolution("Missing.png");
      await openInActiveTab("Saved/Unprepared.html");

      const message = browser.$(`${ACTIVE} .html-page-viewer__message`);
      await message.waitForExist();
      expect(await message.getText()).toContain("Unable to prepare this page");
      expect(await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`).isExisting()).toBe(false);
      await saveScreenshot("unprepared-page");
      expect(await viewPixels(RED)).toBe(0);

      await clickToolbarButton("Source");
      expect(await sourceText()).toBe(html);

      await clickToolbarButton("Rendered");
      await browser.$(`${ACTIVE} .html-page-viewer__message`).waitForExist();
      await restoreHost();
      await browser
        .$(`${ACTIVE} .html-page-viewer__toolbar button[aria-label="Refresh preview"]`)
        .click();
      await waitForPage();
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
      expect(await framePixels(RED)).toBe(0);
    });
  });

  it("lets the viewer read the rendered page while scripts are off", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    const heading = await browser.executeObsidian(() => {
      const frame = document.querySelector<HTMLIFrameElement>(
        ".workspace-leaf.mod-active iframe.html-page-viewer__frame",
      );
      return frame?.contentDocument?.querySelector("h1")?.textContent ?? null;
    });
    expect(heading).toBe("Example article");
  });
});

/** Creates or replaces a vault file, as a fixture that needs the vault's address. */
async function writeVaultFile(filePath: string, text: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, filePath, text) => {
      const file = app.vault.getAbstractFileByPath(filePath);
      if (file === null) await app.vault.create(filePath, text);
      else await app.vault.modify(file as never, text);
    },
    filePath,
    text,
  );
}

/** Makes Obsidian's reads of one vault file fail, until {@link restoreHost}. */
async function failRead(filePath: string): Promise<void> {
  await browser.executeObsidian(({ app }, filePath) => {
    const vault = app.vault as unknown as {
      cachedRead(file: { path: string }): Promise<string>;
    };
    const own = Object.hasOwn(vault, "cachedRead");
    const read = vault.cachedRead;
    vault.cachedRead = (file) =>
      file.path === filePath
        ? Promise.reject(new Error("synthetic read failure"))
        : read.call(vault, file);
    const state = window as unknown as { e2eRestore?: (() => void)[] };
    (state.e2eRestore ??= []).push(() => {
      if (own) vault.cachedRead = read;
      else delete (vault as { cachedRead?: unknown }).cachedRead;
    });
  }, filePath);
}

/** Makes Obsidian's link resolution throw for one link text, until {@link restoreHost}. */
async function failLinkResolution(linktext: string): Promise<void> {
  await browser.executeObsidian(({ app }, linktext) => {
    const cache = app.metadataCache as unknown as {
      getFirstLinkpathDest(linktext: string, source: string): unknown;
    };
    const own = Object.hasOwn(cache, "getFirstLinkpathDest");
    const resolve = cache.getFirstLinkpathDest;
    cache.getFirstLinkpathDest = (text, source) => {
      if (text === linktext) throw new Error("synthetic failure");
      return resolve.call(cache, text, source);
    };
    const state = window as unknown as { e2eRestore?: (() => void)[] };
    (state.e2eRestore ??= []).push(() => {
      if (own) cache.getFirstLinkpathDest = resolve;
      else delete (cache as { getFirstLinkpathDest?: unknown }).getFirstLinkpathDest;
    });
  }, linktext);
}

/** Undoes every failure that a test made in Obsidian. */
async function restoreHost(): Promise<void> {
  await browser.executeObsidian(() => {
    const state = window as unknown as { e2eRestore?: (() => void)[] };
    for (const restore of (state.e2eRestore ?? []).reverse()) restore();
    state.e2eRestore = [];
  });
}

/** How many pixels of the active tab's view, toolbar and all, show `color`. */
async function viewPixels(color: Color): Promise<number> {
  const view = await browser.$(`${ACTIVE} .html-page-viewer`);
  const shot = await browser.takeElementScreenshot(await view.elementId);
  return decodePng(Buffer.from(shot, "base64")).count(color);
}

/** The text that the active tab's source view shows, line by line. */
async function sourceText(): Promise<string> {
  await browser.$(`${ACTIVE} .html-page-viewer__source`).waitForExist();
  return browser.execute(
    (active) =>
      [...document.querySelectorAll(`${active} .html-page-viewer__source-code`)]
        .map((line) => line.textContent ?? "")
        .join("\n"),
    ACTIVE,
  );
}
