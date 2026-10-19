// Helpers for driving the plugin's view in Obsidian.

import path from "node:path";
import { browser } from "@wdio/globals";

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
