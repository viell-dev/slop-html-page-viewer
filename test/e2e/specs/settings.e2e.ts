import { browser, expect } from "@wdio/globals";
import { activeViewType, clickToolbarButton, frameSandbox, openInActiveTab, VIEW_TYPE } from "../support/viewer.ts";

const PLUGIN_ID = "viell-html-page-viewer";

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
  await browser.executeObsidian(({ app }) => (app as unknown as { setting: SettingsWindow }).setting.close());
}

/** The names of the settings that the open settings tab shows. */
async function settingNames(): Promise<string[]> {
  return browser.executeObsidian(({ app }) => {
    const tab = (app as unknown as { setting: SettingsWindow }).setting.activeTab;
    return [...(tab?.containerEl?.querySelectorAll(".setting-item-name") ?? [])].map((name) => name.textContent ?? "");
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
    expect(await settingNames()).toEqual(["Theme in new tabs", "Scripts when a page opens"]);
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

  it("start a new tab with the theme off once that setting is off", async function () {
    await openSettingsTab();
    expect(await clickToggle("Theme in new tabs")).toBe(false);
    await closeSettings();
    try {
      await browser.executeObsidian(async ({ app }) => {
        const file = app.vault.getAbstractFileByPath("Saved/Other page.html");
        await app.workspace.getLeaf("tab").openFile(file as never, { active: true });
      });
      expect(await browser.$(".workspace-leaf.mod-active .html-page-viewer__theme-toggle").getText()).toBe("Theme OFF");
      await clickToolbarButton("Theme OFF");
      expect(await browser.$(".workspace-leaf.mod-active .html-page-viewer__theme-toggle").getText()).toBe("Theme ON");
    } finally {
      await browser.executeObsidian(({ app }) => app.workspace.getMostRecentLeaf()?.detach());
      await openSettingsTab();
      expect(await clickToggle("Theme in new tabs")).toBe(true);
    }
    expect((await savedSettings()).themeOn).toBe(true);
  });
});
