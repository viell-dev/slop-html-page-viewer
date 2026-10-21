import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { button, frame, Harness, sandboxTokens, securityPill, settle } from "./support/harness";
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
    assert.deepEqual(DEFAULT_SETTINGS, {
      themeOn: true,
      scriptsOn: false,
      copyLocalFiles: false,
      wrapSource: true,
      extensions: ["html", "htm"],
    });
  });

  it("reads saved values, and takes the default for one that is missing or of the wrong type", () => {
    assert.deepEqual(
      readSettings({ themeOn: false, scriptsOn: true, copyLocalFiles: true, wrapSource: false }),
      {
        themeOn: false,
        scriptsOn: true,
        copyLocalFiles: true,
        wrapSource: false,
        extensions: ["html", "htm"],
      },
    );
    assert.deepEqual(
      readSettings({ scriptsOn: "yes", themeOn: 0, copyLocalFiles: 1 }),
      DEFAULT_SETTINGS,
    );
    assert.deepEqual(readSettings({ themeOn: false, extra: 1 }), {
      ...DEFAULT_SETTINGS,
      themeOn: false,
    });
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
    assert.deepEqual(harness.plugin.saves.at(-1), {
      themeOn: false,
      scriptsOn: true,
      copyLocalFiles: false,
      wrapSource: true,
      extensions: ["html", "htm"],
    });

    // The open tab keeps what it shows; a new tab follows the settings.
    assert.deepEqual(sandboxTokens(frame(open)!), ["allow-same-origin"]);
    const fresh = harness.newView();
    harness.open(fresh, "fresh.html", PAGE);
    assert.deepEqual(sandboxTokens(frame(fresh)!), ["allow-scripts"]);
    assert.ok(button(fresh, "Theme OFF"));

    tab.display();
    assert.equal(toggle(tab, "Scripts when a page opens").checked, true);
    assert.equal(
      tab.containerEl.querySelectorAll(".setting-item").length,
      5,
      "display() replaces what it showed",
    );
    tab.containerEl.remove();
  });
});

describe("local files with scripts on (#11)", () => {
  const ARTICLE = `<!doctype html><title>Article</title><img src="figure.png"><script src="app.js"></script>`;
  const data = (type: string, text: string): string => `data:${type};base64,${btoa(text)}`;

  async function openArticle(harness: Harness): Promise<ReturnType<Harness["newView"]>> {
    harness.app.files.set("Saved/figure.png", "PNG bytes");
    harness.app.files.set("Saved/app.js", "window.ran = true;");
    const view = harness.newView();
    harness.open(view, "Saved/Article.html", ARTICLE);
    await settle();
    return view;
  }

  function shown(view: ReturnType<Harness["newView"]>): Document {
    return new DOMParser().parseFromString(frame(view)!.srcdoc, "text/html");
  }

  it("are copied into a page only while its scripts are on, when the setting says so", async () => {
    const harness = await Harness.load({ copyLocalFiles: true });
    const view = await openArticle(harness);
    assert.equal(
      shown(view).querySelector("img")?.getAttribute("src"),
      "figure.png",
      "with scripts off, the page loads them",
    );
    assert.deepEqual(harness.app.binaryReads, []);

    button(view, "Scripts OFF").click();
    await settle();
    assert.deepEqual(sandboxTokens(frame(view)!), ["allow-scripts"]);
    assert.equal(
      shown(view).querySelector("img")?.getAttribute("src"),
      data("image/png", "PNG bytes"),
    );
    assert.equal(
      shown(view).querySelector("script")?.getAttribute("src"),
      data("text/javascript", "window.ran = true;"),
    );
    assert.match(
      view.contentEl.querySelector(".html-page-viewer__security")?.textContent ?? "",
      /copied into it, where its scripts can read them/,
    );
  });

  it("are not copied without the setting", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const view = await openArticle(harness);
    assert.equal(shown(view).querySelector("img")?.getAttribute("src"), "figure.png");
    assert.deepEqual(harness.app.binaryReads, []);
    assert.match(
      view.contentEl.querySelector(".html-page-viewer__security")?.textContent ?? "",
      /isolated from Obsidian and from this vault's files/,
    );
  });

  it("follow a change of the setting at once in a page with scripts on", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const view = await openArticle(harness);
    const [tab] = harness.plugin.settingTabs;
    document.body.append(tab.containerEl);
    tab.display();
    flip(toggle(tab, "Local files with scripts on"));
    await settle();
    assert.equal(
      shown(view).querySelector("img")?.getAttribute("src"),
      data("image/png", "PNG bytes"),
    );
    tab.containerEl.remove();
  });

  it("show a page again only when the setting changes what it shows", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const plugin = harness.plugin as unknown as { updateSettings(change: object): Promise<void> };
    const view = await openArticle(harness);
    const first = frame(view);
    await plugin.updateSettings({ wrapSource: false });
    assert.equal(frame(view), first, "another setting leaves the page as it is");
    await plugin.updateSettings({ copyLocalFiles: false });
    assert.equal(frame(view), first, "so does the same value");
    button(view, "Scripts ON").click();
    const off = frame(view);
    await plugin.updateSettings({ copyLocalFiles: true });
    assert.equal(frame(view), off, "a page with scripts off loads its files itself");
  });

  it("are named in the source view's security note when the setting changes", async () => {
    const harness = await Harness.load({ scriptsOn: true });
    const plugin = harness.plugin as unknown as { updateSettings(change: object): Promise<void> };
    const view = await openArticle(harness);
    button(view, "Source").click();
    await plugin.updateSettings({ copyLocalFiles: true });
    assert.match(
      view.contentEl.querySelector(".html-page-viewer__security")?.textContent ?? "",
      /copied into it/,
    );
  });

  it("say when a file is left out over the size limits", async () => {
    const harness = await Harness.load({ scriptsOn: true, copyLocalFiles: true });
    harness.app.files.set("Saved/huge.png", "x".repeat(8_000_001));
    const view = harness.newView();
    harness.open(view, "Saved/Huge.html", `<img src="huge.png">`);
    await settle();
    assert.equal(shown(view).querySelector("img")?.getAttribute("src"), "huge.png");
    assert.equal(
      view.contentEl.querySelector(".html-page-viewer__copy-limit")?.textContent,
      "One local file was left out of the page, over the size limits.",
    );
    assert.deepEqual(harness.app.binaryReads, [], "a file over the limit is not read");
  });
});

describe("wrapping in the source view", () => {
  it("wraps long lines by default, and follows the setting at once in an open view", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    button(view, "Source").click();
    const source = (): HTMLElement | null =>
      view.contentEl.querySelector(".html-page-viewer__source");
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
    assert.equal(
      view.contentEl.querySelector(".html-page-viewer__source")?.classList.contains("is-wrapped"),
      false,
    );
  });
});
