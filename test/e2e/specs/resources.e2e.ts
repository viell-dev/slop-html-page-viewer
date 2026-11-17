import fs from "node:fs";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import { type Color, decodePng, solidPng } from "../support/pixels.ts";
import {
  ACTIVE,
  clickToolbarButton,
  expectNoPixels,
  framePixels,
  openInActiveTab,
  PLUGIN_ID,
  recordedFrames,
  recordedFramesAfterClick,
  saveScreenshot,
  vaultFolder,
  waitForPage,
} from "../support/viewer.ts";

// The fixture image's green, and the mirrored site's banner blue.
const GREEN: Color = [46, 125, 50];
const BLUE: Color = [21, 101, 192];
const RED: Color = [198, 40, 40];
const ORANGE: Color = [239, 108, 0];
const IMAGE_PIXELS = 64 * 64;

describe("A page's local files in Obsidian", function () {
  it("keeps CSS resource-like text visible while loading real resources (#91)", async function () {
    await browser.executeObsidian(async ({ app }) => {
      await app.vault.create(
        "Css tokens.css",
        `p::after { content: 'url(ghost.png)'; } p { color: rgb(46, 125, 50); } /* @import "ghost.css"; */`,
      );
      await app.vault.create(
        "Css tokens.html",
        `<link rel="stylesheet" href="Css tokens.css"><p>Text</p>`,
      );
    });
    try {
      await openInActiveTab("Css tokens.html");
      await waitForPage();
      const shown = await browser.execute((active) => {
        const doc = document.querySelector<HTMLIFrameElement>(`${active} iframe`)!.contentDocument!;
        const p = doc.querySelector("p")!;
        return {
          content: doc.defaultView!.getComputedStyle(p, "::after").content,
          color: doc.defaultView!.getComputedStyle(p).color,
        };
      }, ACTIVE);
      expect(shown).toEqual({ content: '"url(ghost.png)"', color: "rgb(46, 125, 50)" });
    } finally {
      await browser.executeObsidian(async ({ app }) => {
        for (const path of ["Css tokens.html", "Css tokens.css"]) {
          const file = app.vault.getAbstractFileByPath(path);
          if (file) await app.vault.delete(file);
        }
      });
    }
  });

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

  describe("in shadow DOM (#124)", function () {
    /** Whether the page shows its image, found by name, and a square from each of its stylesheets. */
    async function shadowContent(): Promise<Record<string, boolean>> {
      const shows = async (color: Color) => (await framePixels(color)) >= IMAGE_PIXELS * 0.9;
      return {
        image: await shows(GREEN),
        linked: await shows(BLUE),
        imported: await shows(ORANGE),
      };
    }

    it("shows the files that it names, also by name, and applies its stylesheets", async function () {
      await openInActiveTab("Saved/Shadow resources.html");
      await waitForPage();
      await saveScreenshot("shadow-resources");
      expect(await shadowContent()).toEqual({ image: true, linked: true, imported: true });
    });

    it("copies the files that it names into a page with scripts on", async function () {
      await copyLocalFiles(true);
      try {
        await openInActiveTab("Saved/Shadow resources.html");
        await clickToolbarButton("Scripts OFF");
        await waitForPage();
        await saveScreenshot("shadow-resources-scripts-on");
        expect(await shadowContent()).toEqual({ image: true, linked: true, imported: true });
      } finally {
        await clickToolbarButton("Scripts ON");
        await copyLocalFiles(false);
      }
    });
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
    await expectNoPixels(GREEN, "scripts on");
    await clickToolbarButton("Scripts ON");
  });

  it("gives a frame with scripts on an opaque origin in Obsidian's main process from the start (#83)", async function () {
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();
    // Obsidian serves vault files to a frame by the origin its main process
    // records, which it updates only once it learns that the frame's page
    // committed. Read right after the click, the record shows the frame as it
    // was created, before its page loads.
    const created = await recordedFramesAfterClick("Scripts OFF");
    await waitForPage();
    const loaded = await recordedFrames();
    // With scripts off again, the frame keeps Obsidian's origin, which the
    // record shows; the tab is back as the next test expects it.
    await clickToolbarButton("Scripts ON");
    await waitForPage();
    const scriptsOff = await recordedFrames();
    expect({ created, loaded, scriptsOff }).toEqual({
      created: { frames: 1, origins: ["null"] },
      loaded: { frames: 1, origins: ["null"] },
      scriptsOff: { frames: 1, origins: ["app://obsidian.md"] },
    });
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
      expect(await framePixels(RED)).toBe(0);
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
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
      expect(await framePixels(RED)).toBe(0);
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
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
      expect(await framePixels(RED)).toBe(0);
      expect(await framePixels(GREEN)).toBeGreaterThanOrEqual(IMAGE_PIXELS * 0.9);
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

/**
 * Turns the **Local files with scripts on** setting on or off for the pages
 * that render next, without saving it, which settings.e2e.ts tests.
 */
async function copyLocalFiles(on: boolean): Promise<void> {
  await browser.executeObsidian(
    ({ app }, id, on) => {
      const plugins = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins;
      (plugins.plugins[id] as { settings: { copyLocalFiles: boolean } }).settings.copyLocalFiles =
        on;
    },
    PLUGIN_ID,
    on,
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
