import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/dom";
import { DEFAULT_EXTENSIONS, ExtensionRegistration, normalizeExtensions } from "../src/extensions";
import { frame, Harness, message, VIEW_TYPE } from "./support/harness";
import { App, type PluginSettingTab } from "./support/obsidian";

const PAGE = "<!doctype html><title>Report</title><p>Quarterly figures</p>";

/** The settings tab's field for the setting named `name`, and its description. */
function field(
  tab: PluginSettingTab,
  name: string,
): { input: HTMLInputElement; description: string } {
  const setting = [...tab.containerEl.querySelectorAll(".setting-item")].find(
    (item) => item.querySelector(".setting-item-name")?.textContent === name,
  );
  const input = setting?.querySelector<HTMLInputElement>("input[type=text]");
  assert.ok(input, `a text field named ${name}`);
  return {
    input,
    description: setting?.querySelector(".setting-item-description")?.textContent ?? "",
  };
}

/** Types into a field and leaves it, as a person does: the change event fires on leaving. */
function enter(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new input.ownerDocument.defaultView!.Event("change"));
}

function registered(app: App): [string, string][] {
  return [...(app.viewRegistry?.typeByExtension ?? [])];
}

describe("normalizeExtensions", () => {
  it("takes extensions in lower case, without dots, each once, in their order", () => {
    assert.deepEqual(normalizeExtensions(".HTML, htm ,, xht; .XHTML  hbs"), [
      "html",
      "htm",
      "xht",
      "xhtml",
      "hbs",
    ]);
    assert.deepEqual(normalizeExtensions(["Html", "html", 3, null, ".tpl"]), ["html", "tpl"]);
  });

  it("leaves out what cannot be an extension, and means the defaults when nothing is left", () => {
    assert.deepEqual(normalizeExtensions("tar.gz, html, a/b, c\\d"), ["html"]);
    assert.deepEqual(normalizeExtensions(""), DEFAULT_EXTENSIONS);
    assert.deepEqual(normalizeExtensions(" , ; "), DEFAULT_EXTENSIONS);
    assert.deepEqual(normalizeExtensions([]), DEFAULT_EXTENSIONS);
  });

  it("accepts letters and digits of any script", () => {
    assert.deepEqual(normalizeExtensions("htmé, h5"), ["htmé", "h5"]);
  });
});

describe("ExtensionRegistration", () => {
  it("holds the wanted extensions, but not those another view has", () => {
    const app = new App();
    const registration = new ExtensionRegistration(app.viewRegistry!, VIEW_TYPE);
    registration.apply(["html", "md", "xht"]);
    assert.deepEqual(registration.held, ["html", "xht"]);
    assert.deepEqual(registration.refused, ["md"]);
    assert.deepEqual(registered(app), [
      ["md", "markdown"],
      ["html", VIEW_TYPE],
      ["xht", VIEW_TYPE],
    ]);
  });

  it("gives up only its own extensions, also those another view took since", () => {
    const app = new App();
    const registry = app.viewRegistry!;
    const registration = new ExtensionRegistration(registry, VIEW_TYPE);
    registration.apply(["html", "xht"]);
    // Another plugin takes .xht after this one gave it up and before it applies again.
    registry.unregisterExtensions(["xht"]);
    registry.registerExtensions(["xht"], "other-view");

    registration.apply(["html"]);
    assert.deepEqual(registration.held, ["html"]);
    assert.equal(registry.getTypeByExtension("xht"), "other-view");
    registration.releaseAll();
    assert.deepEqual(registered(app), [
      ["md", "markdown"],
      ["xht", "other-view"],
    ]);
  });
});

describe("extensions in the plugin", () => {
  it("opens the files of every listed extension as HTML, and none of the others", async () => {
    const harness = await Harness.load({ extensions: ["html", "xht"] });
    const listed = harness.newView();
    harness.open(listed, "Pages/page.xht", PAGE);
    assert.ok(frame(listed));
    const unlisted = harness.newView();
    harness.open(unlisted, "Pages/page.htm", PAGE);
    assert.equal(frame(unlisted), null);
    assert.equal(
      message(unlisted),
      "The viewer does not open .htm files. Its settings list the extensions it opens as HTML.",
    );
  });

  it("follows a change in the settings tab at once, and says which extensions another view has", async () => {
    const harness = await Harness.load();
    const [tab] = harness.plugin.settingTabs;
    document.body.append(tab.containerEl);
    tab.display();
    const before = field(tab, "File extensions");
    assert.equal(before.input.value, "html, htm");
    assert.equal(before.input.placeholder, "html, htm");

    enter(before.input, ".HTML, md, xht");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(registered(harness.app), [
      ["md", "markdown"],
      ["html", VIEW_TYPE],
      ["xht", VIEW_TYPE],
    ]);
    assert.deepEqual((harness.plugin.saves.at(-1) as { extensions: string[] }).extensions, [
      "html",
      "md",
      "xht",
    ]);
    const after = field(tab, "File extensions");
    assert.equal(after.input.value, "html, md, xht");
    assert.match(after.description, /Another view opens \.md, so the viewer does not\./);

    enter(after.input, "");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(registered(harness.app), [
      ["md", "markdown"],
      ["html", VIEW_TYPE],
      ["htm", VIEW_TYPE],
    ]);
    tab.containerEl.remove();
  });

  it("says that a change waits for the next load where Obsidian has no view registry", async () => {
    const harness = await Harness.load(null, { viewRegistry: false });
    const [tab] = harness.plugin.settingTabs;
    tab.display();
    assert.match(
      field(tab, "File extensions").description,
      /A change applies when Obsidian loads the plugin again\./,
    );
  });
});
