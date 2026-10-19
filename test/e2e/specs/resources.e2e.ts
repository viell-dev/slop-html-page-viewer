import fs from "node:fs";
import path from "node:path";
import { browser, expect } from "@wdio/globals";
import { type Color, solidPng } from "../support/pixels.ts";
import { clickToolbarButton, framePixels, openInActiveTab, saveScreenshot, vaultFolder, waitForPage } from "../support/viewer.ts";

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
