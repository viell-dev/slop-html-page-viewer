// Helpers for driving the plugin's view in Obsidian.

import path from "node:path";
import { browser } from "@wdio/globals";
import { type Color, decodePng } from "./pixels.ts";

export const PLUGIN_ID = "viell-html-page-viewer";
export const VIEW_TYPE = "html-page-viewer";

/** The active tab, to which the other selectors are scoped. */
export const ACTIVE = ".workspace-leaf.mod-active";

/** Whether Obsidian has loaded the plugin. */
export async function isLoaded(): Promise<boolean> {
  return browser.executeObsidian(({ app }, id) => {
    const plugins = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins;
    return id in plugins.plugins;
  }, PLUGIN_ID);
}

/** Opens a vault file in the active tab, reusing its view as Obsidian does. */
export async function openInActiveTab(filePath: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file === null || !("extension" in file)) throw new Error(`No file at ${filePath}`);
    await app.workspace.getLeaf(false).openFile(file as never);
  }, filePath);
}

/** The view type of the active tab. */
export async function activeViewType(): Promise<string | undefined> {
  return browser.executeObsidian(({ app }) => app.workspace.getMostRecentLeaf()?.view.getViewType());
}

/**
 * Marks the active tab's view object, so that a later {@link isMarkedView}
 * tells whether Obsidian kept the same object.
 */
export async function markActiveView(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    const view = app.workspace.getMostRecentLeaf()?.view as { e2eMarker?: boolean } | undefined;
    if (view) view.e2eMarker = true;
  });
}

export async function isMarkedView(): Promise<boolean> {
  return browser.executeObsidian(({ app }) => {
    const view = app.workspace.getMostRecentLeaf()?.view as { e2eMarker?: boolean } | undefined;
    return view?.e2eMarker === true;
  });
}

export async function frameSandbox(): Promise<string | null> {
  const frame = await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`);
  await frame.waitForExist();
  return frame.getAttribute("sandbox");
}

export async function clickToolbarButton(text: string): Promise<void> {
  const toolbar = browser.$(`${ACTIVE} .html-page-viewer__toolbar`);
  const button = await toolbar.$(`button=${text}`);
  await button.click();
}

export async function saveScreenshot(name: string): Promise<void> {
  const root = path.resolve(import.meta.dirname, "../../..");
  const output = process.env.E2E_OUTPUT_DIR?.trim() || path.join(root, "test-results", "e2e");
  const version = browser.getObsidianVersion();
  await browser.saveScreenshot(path.join(output, "screenshots", `${version}-${name}.png`));
}

/** The vault's folder on disk. */
export async function vaultFolder(): Promise<string> {
  return browser.executeObsidian(({ app }) => (app.vault.adapter as unknown as { basePath: string }).basePath);
}

/** Waits until the active tab's frame has rendered its page. */
export async function waitForPage(): Promise<void> {
  const frame = await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`);
  await frame.waitForExist();
  let state = "none";
  await browser.waitUntil(
    async () => {
      state = await browser.execute((active) => {
        const frame = document.querySelector<HTMLIFrameElement>(`${active} iframe.html-page-viewer__frame`);
        if (!frame?.srcdoc) return "none";
        const doc = frame.contentDocument;
        return doc === null ? "opaque" : doc.URL === "about:srcdoc" ? doc.readyState : "none";
      }, ACTIVE);
      return state === "complete" || state === "opaque";
    },
    { timeout: 20_000, timeoutMsg: "the frame's page did not finish loading" },
  );
  // A page with an opaque origin (scripts on) cannot be reached to see when it
  // has loaded, so give its resources a moment.
  if (state === "opaque") await browser.pause(1000);
}

/** How many pixels of the active tab's frame show `color`. */
export async function framePixels(color: Color): Promise<number> {
  const frame = await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`);
  const shot = await browser.takeElementScreenshot(await frame.elementId);
  return decodePng(Buffer.from(shot, "base64")).count(color);
}

/** Where a link in the active tab's page is, once it has stopped moving. */
async function stablePoint(selector: string): Promise<{ x: number; y: number }> {
  return browser.execute(async (selector) => {
    const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
    const target = frame?.contentDocument?.querySelector(selector);
    if (!frame || !target) throw new Error(`No ${selector} in the page`);
    target.scrollIntoView({ block: "center" });
    const measure = () => {
      const outer = frame.getBoundingClientRect();
      const inner = target.getBoundingClientRect();
      return { x: Math.round(outer.left + inner.left + 4), y: Math.round(outer.top + inner.top + inner.height / 2) };
    };
    // Text can reflow while fonts load; wait until two measurements agree.
    let point = measure();
    for (let tries = 0; tries < 30; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = measure();
      if (next.x === point.x && next.y === point.y) break;
      point = next;
    }
    return point;
  }, selector);
}

/**
 * Clicks a link in the active tab's page, as a user does, with optional
 * modifier keys. It checks that the click reached the link, and clicks again
 * when the page moved under the pointer.
 */
export async function clickInPage(selector: string, modifiers: string[] = []): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const point = await stablePoint(selector);
    await browser.execute((selector) => {
      const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
      const state = window as unknown as { e2eHit?: boolean };
      state.e2eHit = false;
      const record = (event: Event) => {
        state.e2eHit ||= (event.target as Element | null)?.closest?.(selector) != null;
      };
      // The window sees the event before the view's listeners on the document,
      // which may replace the frame while the event is still being delivered.
      frame?.contentWindow?.addEventListener("click", record, true);
      frame?.contentWindow?.addEventListener("auxclick", record, true);
    }, selector);
    if (modifiers.length > 0) await browser.action("key").down(modifiers[0]).perform(true);
    await browser.action("pointer").move(point).down().up().perform();
    if (modifiers.length > 0) await browser.action("key").up(modifiers[0]).perform();
    if (await browser.execute(() => (window as unknown as { e2eHit?: boolean }).e2eHit === true)) return attempt;
  }
  throw new Error(`Three clicks at ${selector} missed it`);
}
/** The active tab's file path and view type. */
export async function activeFile(): Promise<{ path: string | null; type: string | null }> {
  return browser.executeObsidian(({ app }) => {
    const leaf = app.workspace.getMostRecentLeaf();
    const view = leaf?.view as { file?: { path: string } | null; getViewType(): string } | undefined;
    return { path: view?.file?.path ?? null, type: view?.getViewType() ?? null };
  });
}
