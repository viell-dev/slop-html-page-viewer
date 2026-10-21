import { browser, expect } from "@wdio/globals";
import type { Color } from "../support/pixels.ts";
import {
  activeViewType,
  clickToolbarButton,
  framePixels,
  frameSandbox,
  openInActiveTab,
  VIEW_TYPE,
  waitForPage,
} from "../support/viewer.ts";

const PLUGIN_ID = "viell-html-page-viewer";

// The saved article's image, and the square that the mirrored page's script draws.
const GREEN: Color = [46, 125, 50];
const PURPLE: Color = [106, 27, 154];
const SQUARE_PIXELS = 64 * 64;

// Obsidian 1.5 shows its settings in a dialog in the main window; 1.14 opens
// them in a window of their own, with its own document. The helpers reach the
// settings tab through Obsidian's settings object, which works in both.
interface SettingsWindow {
  open(): void;
  close(): void;
  openTabById(id: string): void;
  activeTab?: { id?: string; containerEl?: HTMLElement } | null;
}

/** Opens the plugin's tab in Obsidian's settings, as its sidebar does. */
async function openSettingsTab(): Promise<void> {
  await browser.executeObsidian(({ app }, id) => {
    const setting = (app as unknown as { setting: SettingsWindow }).setting;
    setting.open();
    setting.openTabById(id);
  }, PLUGIN_ID);
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }, id) => {
        const tab = (app as unknown as { setting: SettingsWindow }).setting.activeTab;
        return tab?.id === id && (tab.containerEl?.querySelector(".setting-item") ?? null) !== null;
      }, PLUGIN_ID),
    { timeoutMsg: "The plugin's settings tab did not open" },
  );
}

async function closeSettings(): Promise<void> {
  await browser.executeObsidian(({ app }) =>
    (app as unknown as { setting: SettingsWindow }).setting.close(),
  );
}

/** The names of the settings that the open settings tab shows. */
async function settingNames(): Promise<string[]> {
  return browser.executeObsidian(({ app }) => {
    const tab = (app as unknown as { setting: SettingsWindow }).setting.activeTab;
    return [...(tab?.containerEl?.querySelectorAll(".setting-item-name") ?? [])].map(
      (name) => name.textContent ?? "",
    );
  });
}

/** Clicks the toggle of the setting named `name`, and returns whether it is on afterwards. */
async function clickToggle(name: string): Promise<boolean> {
  return browser.executeObsidian(({ app }, name) => {
    const tab = (app as unknown as { setting: SettingsWindow }).setting.activeTab;
    const item = [...(tab?.containerEl?.querySelectorAll(".setting-item") ?? [])].find(
      (candidate) => candidate.querySelector(".setting-item-name")?.textContent === name,
    );
    const toggle = item?.querySelector<HTMLElement>(".checkbox-container");
    if (!toggle) throw new Error(`No toggle named ${name}`);
    toggle.click();
    return toggle.classList.contains("is-enabled");
  }, name);
}

/**
 * Types into the text field of the setting named `name` and leaves it, as a
 * person does, and returns the setting's description afterwards.
 */
async function enterText(name: string, text: string): Promise<string> {
  return browser.executeObsidian(
    async ({ app }, name, text) => {
      const setting = (app as unknown as { setting: SettingsWindow }).setting;
      const find = () =>
        [...(setting.activeTab?.containerEl?.querySelectorAll(".setting-item") ?? [])].find(
          (candidate) => candidate.querySelector(".setting-item-name")?.textContent === name,
        );
      const before = find();
      const input = before?.querySelector<HTMLInputElement>("input[type=text]");
      if (!input) throw new Error(`No text field named ${name}`);
      input.value = text;
      // The settings window may be a window of its own, with its own Event.
      const view = input.ownerDocument.defaultView as (Window & typeof globalThis) | null;
      input.dispatchEvent(new (view ?? window).Event("change"));
      // The tab shows the change once the plugin has saved the settings and
      // rendered the tab again, which replaces its elements; however long the
      // save takes (#71).
      const deadline = Date.now() + 10_000;
      while (find() === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (find() === before)
        throw new Error(`The settings tab did not render again after ${name} changed`);
      return find()?.querySelector(".setting-item-description")?.textContent ?? "";
    },
    name,
    text,
  );
}

/** The view type that Obsidian's view registry gives an extension. */
async function viewTypeFor(extension: string): Promise<string | null> {
  return browser.executeObsidian(
    ({ app }, extension) =>
      (
        app as unknown as { viewRegistry: { getTypeByExtension(e: string): string | undefined } }
      ).viewRegistry.getTypeByExtension(extension) ?? null,
    extension,
  );
}

/** The settings as the plugin saved them in the vault. */
async function savedSettings(): Promise<Record<string, unknown>> {
  const text = await browser.executeObsidian(
    async ({ app }, id) => app.vault.adapter.read(`${app.vault.configDir}/plugins/${id}/data.json`),
    PLUGIN_ID,
  );
  return JSON.parse(text) as Record<string, unknown>;
}

describe("The settings in Obsidian", function () {
  afterEach(async function () {
    await closeSettings();
  });

  it("are in the plugin's tab of Obsidian's settings", async function () {
    await openSettingsTab();
    expect(await settingNames()).toEqual([
      "Theme in new tabs",
      "Scripts when a page opens",
      "Local files with scripts on",
      "Wrap long lines in the source view",
      "File extensions",
    ]);
  });

  it("open the files of every listed extension as HTML, and leave others' extensions to them", async function () {
    expect(await viewTypeFor("xht")).toBe(null);
    await openSettingsTab();
    const description = await enterText("File extensions", "html, htm, .XHT, md");
    expect(description).toContain("Another view opens .md, so the viewer does not.");
    await closeSettings();
    try {
      expect((await savedSettings()).extensions).toEqual(["html", "htm", "xht", "md"]);
      expect(await viewTypeFor("xht")).toBe(VIEW_TYPE);
      expect(await viewTypeFor("md")).toBe("markdown");
      await openInActiveTab("Saved/Other extension.xht");
      expect(await activeViewType()).toBe(VIEW_TYPE);
      expect(await frameSandbox()).toBe("allow-same-origin");
      await openInActiveTab("Notes/Topic.md");
      expect(await activeViewType()).toBe("markdown");
    } finally {
      await openSettingsTab();
      await enterText("File extensions", "");
      await closeSettings();
    }
    expect(await viewTypeFor("xht")).toBe(null);
    expect(await viewTypeFor("htm")).toBe(VIEW_TYPE);
    expect((await savedSettings()).extensions).toEqual(["html", "htm"]);
  });

  it("wrap long lines in the source view, and stop at once when wrapping is turned off", async function () {
    /** The active source view's width and scroll width, and the height of its longest line. */
    const source = async (): Promise<{ overflow: number; tallest: number; lineHeight: number }> =>
      browser.execute(() => {
        const view = document.querySelector<HTMLElement>(
          ".workspace-leaf.mod-active .html-page-viewer__source",
        );
        const lines = [
          ...(view?.querySelectorAll<HTMLElement>(".html-page-viewer__source-line") ?? []),
        ];
        const heights = lines.map((line) => line.getBoundingClientRect().height);
        return {
          overflow: view ? view.scrollWidth - view.clientWidth : 0,
          tallest: Math.max(...heights),
          lineHeight: Math.min(...heights),
        };
      });
    await openInActiveTab("Saved/Long lines.html");
    await clickToolbarButton("Source");
    const wrapped = await source();
    expect(wrapped.overflow).toBeLessThanOrEqual(1);
    expect(wrapped.tallest).toBeGreaterThan(wrapped.lineHeight * 2);

    await openSettingsTab();
    expect(await clickToggle("Wrap long lines in the source view")).toBe(false);
    await closeSettings();
    try {
      const unwrapped = await source();
      expect(unwrapped.overflow).toBeGreaterThan(100);
      expect(unwrapped.tallest).toBeLessThan(unwrapped.lineHeight * 1.5);
    } finally {
      await openSettingsTab();
      expect(await clickToggle("Wrap long lines in the source view")).toBe(true);
      await closeSettings();
    }
    expect((await source()).overflow).toBeLessThanOrEqual(1);
    await clickToolbarButton("Rendered");
  });

  it("open the next page with scripts on once the setting is on, and save it", async function () {
    await openInActiveTab("Saved/Example article.html");
    expect(await frameSandbox()).toBe("allow-same-origin");

    await openSettingsTab();
    expect(await clickToggle("Scripts when a page opens")).toBe(true);
    await closeSettings();
    try {
      expect((await savedSettings()).scriptsOn).toBe(true);
      // The open page keeps what it shows; the next one opens with scripts on.
      expect(await frameSandbox()).toBe("allow-same-origin");
      await openInActiveTab("Saved/Other page.html");
      expect(await activeViewType()).toBe(VIEW_TYPE);
      expect(await frameSandbox()).toBe("allow-scripts");
    } finally {
      await openSettingsTab();
      expect(await clickToggle("Scripts when a page opens")).toBe(false);
      await closeSettings();
    }
    await openInActiveTab("Saved/Example article.html");
    expect(await frameSandbox()).toBe("allow-same-origin");
  });

  it("copy a page's local images and scripts into it with scripts on once that setting is on (#11)", async function () {
    /** Waits until the active tab's frame shows at least count pixels of color, and returns how many. */
    const shows = async (color: Color, count: number): Promise<number> => {
      let seen = 0;
      await browser
        .waitUntil(async () => (seen = await framePixels(color)) >= count, { timeout: 10_000 })
        .catch(() => undefined);
      return seen;
    };
    await openInActiveTab("Saved/Example article.html");
    await clickToolbarButton("Scripts OFF");
    expect(await frameSandbox()).toBe("allow-scripts");
    await waitForPage();
    expect(await framePixels(GREEN)).toBe(0);

    await openSettingsTab();
    expect(await clickToggle("Local files with scripts on")).toBe(true);
    await closeSettings();
    try {
      expect((await savedSettings()).copyLocalFiles).toBe(true);
      // The open page, with scripts on, shows its image at once.
      expect(await shows(GREEN, SQUARE_PIXELS * 0.9)).toBeGreaterThanOrEqual(SQUARE_PIXELS * 0.9);
      expect(await frameSandbox()).toBe("allow-scripts");

      await openInActiveTab("Mirror/script.html");
      await waitForPage();
      expect(await framePixels(PURPLE)).toBe(0);
      await clickToolbarButton("Scripts OFF");
      expect(await shows(PURPLE, SQUARE_PIXELS * 0.9)).toBeGreaterThanOrEqual(SQUARE_PIXELS * 0.9);
    } finally {
      await openSettingsTab();
      expect(await clickToggle("Local files with scripts on")).toBe(false);
      await closeSettings();
    }
    // Without the setting, the page with scripts on shows none of its files again.
    await waitForPage();
    expect(await framePixels(PURPLE)).toBe(0);
    await clickToolbarButton("Scripts ON");
  });

  it("start a new tab with the theme off once that setting is off", async function () {
    await openSettingsTab();
    expect(await clickToggle("Theme in new tabs")).toBe(false);
    await closeSettings();
    try {
      await browser.executeObsidian(async ({ app }) => {
        const file = app.vault.getAbstractFileByPath("Saved/Other page.html");
        await app.workspace.getLeaf("tab").openFile(file as never, { active: true });
      });
      expect(
        await browser.$(".workspace-leaf.mod-active .html-page-viewer__theme-toggle").getText(),
      ).toBe("Theme OFF");
      await clickToolbarButton("Theme OFF");
      expect(
        await browser.$(".workspace-leaf.mod-active .html-page-viewer__theme-toggle").getText(),
      ).toBe("Theme ON");
    } finally {
      await browser.executeObsidian(({ app }) => app.workspace.getMostRecentLeaf()?.detach());
      await openSettingsTab();
      expect(await clickToggle("Theme in new tabs")).toBe(true);
    }
    expect((await savedSettings()).themeOn).toBe(true);
  });
});
