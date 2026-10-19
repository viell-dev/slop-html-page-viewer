import { browser, expect } from "@wdio/globals";
import type { Color } from "../support/pixels.ts";
import { clickToolbarButton, framePixels, openInActiveTab, saveScreenshot, waitForPage } from "../support/viewer.ts";

const WHITE: Color = [255, 255, 255];

/** Switches Obsidian's base theme, as its appearance settings do. */
async function setDark(dark: boolean): Promise<void> {
  await browser.executeObsidian(({ app }, dark) => {
    const theme = dark ? "obsidian" : "moonstone";
    const internal = app as unknown as { changeTheme?: (name: string) => void; setTheme?: (name: string) => void };
    if (internal.changeTheme) internal.changeTheme(theme);
    else internal.setTheme?.(theme);
  }, dark);
  await browser.waitUntil(
    async () => (await browser.execute(() => document.body.classList.contains("theme-dark"))) === dark,
    { timeoutMsg: `Obsidian did not switch to the ${dark ? "dark" : "light"} theme` },
  );
}

/** Obsidian's background color, as the frame shows it. */
async function themeBackground(): Promise<Color> {
  const rgb = await browser.execute(() => {
    const probe = document.body.createDiv();
    probe.style.background = "var(--background-primary)";
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  const [red, green, blue] = (rgb.match(/\d+/g) ?? []).map(Number);
  return [red, green, blue];
}

/** The share of the active tab's frame that shows `color`. */
async function frameShare(color: Color): Promise<number> {
  const size = await browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
    const rect = frame?.getBoundingClientRect();
    return rect ? rect.width * rect.height * window.devicePixelRatio ** 2 : 1;
  });
  return (await framePixels(color)) / size;
}

async function markFrame(): Promise<void> {
  await browser.execute(() => {
    const frame = document.querySelector(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
    frame?.setAttribute("data-e2e-marker", "");
  });
}

async function frameIsMarked(): Promise<boolean> {
  return browser.execute(
    () => document.querySelector(".workspace-leaf.mod-active iframe.html-page-viewer__frame[data-e2e-marker]") !== null,
  );
}

describe("The reading style in Obsidian", function () {
  after(async function () {
    await setDark(false);
  });

  it("shows a page without styles in the dark theme's colors", async function () {
    await setDark(true);
    await openInActiveTab("Saved/Other page.html");
    await waitForPage();
    await saveScreenshot("other-page-dark");
    expect(await frameShare(await themeBackground())).toBeGreaterThan(0.5);
  });

  it("follows a change of theme without reloading the page", async function () {
    await openInActiveTab("Saved/Other page.html");
    await waitForPage();
    await markFrame();
    await setDark(false);
    await browser.pause(500);
    expect(await frameIsMarked()).toBe(true);
    expect(await frameShare(await themeBackground())).toBeGreaterThan(0.5);
    await setDark(true);
    await browser.pause(500);
    expect(await frameShare(await themeBackground())).toBeGreaterThan(0.5);
  });

  it("shows the page as a browser would when the theme is turned off", async function () {
    await openInActiveTab("Saved/Other page.html");
    await clickToolbarButton("Theme ON");
    await waitForPage();
    expect(await frameShare(WHITE)).toBeGreaterThan(0.5);
    await clickToolbarButton("Theme OFF");
  });

  it("leaves a page with its own stylesheet as it is", async function () {
    await openInActiveTab("Mirror/index.html");
    await waitForPage();
    await saveScreenshot("mirror-dark");
    expect(await frameShare(WHITE)).toBeGreaterThan(0.3);
    const disabled = await browser.execute(
      () => document.querySelector<HTMLButtonElement>(".workspace-leaf.mod-active .html-page-viewer__theme-toggle")?.disabled,
    );
    expect(disabled).toBe(true);
  });
});
