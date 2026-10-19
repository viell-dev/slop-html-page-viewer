import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { button, frame, Harness, sandboxTokens, securityPill } from "./support/harness";
import type { PluginSettingTab } from "./support/obsidian";

const PAGE = "<!doctype html><title>Report</title><p>Quarterly figures</p>";

/** The settings tab's toggle for the setting named `name`. */
function toggle(tab: PluginSettingTab, name: string): HTMLInputElement {
  const setting = [...tab.containerEl.querySelectorAll(".setting-item")].find(
    (item) => item.querySelector(".setting-item-name")?.textContent === name,
  );
  const input = setting?.querySelector<HTMLInputElement>("input[type=checkbox]");
  assert.ok(input, `a toggle named ${name}`);
  return input;
}

/** Turns a toggle over as a click does, which fires its change event. */
function flip(input: HTMLInputElement): void {
  input.click();
}

describe("readSettings", () => {
  it("keeps today's behavior for a vault without saved settings", () => {
    assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(readSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(DEFAULT_SETTINGS, { themeOn: true, scriptsOn: false, wrapSource: true });
  });

  it("reads saved values, and takes the default for one that is missing or of the wrong type", () => {
    assert.deepEqual(readSettings({ themeOn: false, scriptsOn: true, wrapSource: false }), {
      themeOn: false,
      scriptsOn: true,
      wrapSource: false,
    });
    assert.deepEqual(readSettings({ scriptsOn: "yes", themeOn: 0 }), DEFAULT_SETTINGS);
    assert.deepEqual(readSettings({ themeOn: false, extra: 1 }), { ...DEFAULT_SETTINGS, themeOn: false });
    assert.deepEqual(readSettings("not an object"), DEFAULT_SETTINGS);
  });
});

describe("settings in the view", () => {
  it("opens pages with scripts on when the settings say so, for every file", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const view = harness.newView();
    harness.open(view, "first.html", PAGE);
    assert.deepEqual(sandboxTokens(frame(view)!), ["allow-scripts"]);
    assert.equal(securityPill(view), "Scripts ON");

    button(view, "Scripts ON").click();
    harness.open(view, "second.html", PAGE);
    assert.deepEqual(sandboxTokens(frame(view)!), ["allow-scripts"]);
  });

  it("starts new tabs with the theme off when the settings say so, unless the tab chose otherwise", async () => {
    const harness = await Harness.load({ themeOn: false });
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    assert.equal(button(view, "Theme OFF").getAttribute("aria-pressed"), "false");

    button(view, "Theme OFF").click();
    const next = harness.newView(view.leaf);
    harness.open(next, "page.html", PAGE);
    assert.equal(button(next, "Theme ON").getAttribute("aria-pressed"), "true");
  });
});

describe("settings tab", () => {
  it("shows the settings and saves a change, which applies to what opens next", async () => {
    const harness = await Harness.load();
    const [tab] = harness.plugin.settingTabs;
    assert.ok(tab, "the plugin adds a settings tab");
    // Obsidian shows the tab in its settings window; a checkbox outside a
    // document fires no change event.
    document.body.append(tab.containerEl);
    tab.display();
    const theme = toggle(tab, "Theme in new tabs");
    const scripts = toggle(tab, "Scripts when a page opens");
    assert.equal(theme.checked, true);
    assert.equal(scripts.checked, false);

    const open = harness.newView();
    harness.open(open, "open.html", PAGE);
    flip(scripts);
    flip(theme);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(harness.plugin.saves.at(-1), { themeOn: false, scriptsOn: true, wrapSource: true });

    // The open tab keeps what it shows; a new tab follows the settings.
    assert.deepEqual(sandboxTokens(frame(open)!), ["allow-same-origin"]);
    const fresh = harness.newView();
    harness.open(fresh, "fresh.html", PAGE);
    assert.deepEqual(sandboxTokens(frame(fresh)!), ["allow-scripts"]);
    assert.ok(button(fresh, "Theme OFF"));

    tab.display();
    assert.equal(toggle(tab, "Scripts when a page opens").checked, true);
    assert.equal(tab.containerEl.querySelectorAll(".setting-item").length, 3, "display() replaces what it showed");
    tab.containerEl.remove();
  });
});

describe("wrapping in the source view", () => {
  it("wraps long lines by default, and follows the setting at once in an open view", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    button(view, "Source").click();
    const source = (): HTMLElement | null => view.contentEl.querySelector(".html-page-viewer__source");
    assert.equal(source()?.classList.contains("is-wrapped"), true);

    const [tab] = harness.plugin.settingTabs;
    document.body.append(tab.containerEl);
    tab.display();
    flip(toggle(tab, "Wrap long lines in the source view"));
    assert.equal(source()?.classList.contains("is-wrapped"), false);
    tab.containerEl.remove();
  });

  it("starts unwrapped when the settings say so", async () => {
    const harness = await Harness.load({ wrapSource: false });
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    button(view, "Source").click();
    assert.equal(view.contentEl.querySelector(".html-page-viewer__source")?.classList.contains("is-wrapped"), false);
  });
});