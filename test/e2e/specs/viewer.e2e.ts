import { browser, expect } from "@wdio/globals";
import {
  ACTIVE,
  activeViewType,
  clickToolbarButton,
  frameSandbox,
  isLoaded,
  isMarkedView,
  markActiveView,
  openInActiveTab,
  saveScreenshot,
  VIEW_TYPE,
} from "../support/viewer.ts";

describe("The viewer in Obsidian", function () {
  it("is loaded when the vault opens", async function () {
    expect(await isLoaded()).toBe(true);
  });

  it("opens an HTML file in its view, in a frame that cannot run scripts", async function () {
    await openInActiveTab("Saved/Example article.html");
    expect(await activeViewType()).toBe(VIEW_TYPE);
    expect(await frameSandbox()).toBe("allow-same-origin");
    await saveScreenshot("example-article");
  });

  it("grants only allow-scripts, without same-origin access, when scripts are turned on", async function () {
    await openInActiveTab("Interactive.html");
    await clickToolbarButton("Scripts OFF");
    expect(await frameSandbox()).toBe("allow-scripts");
    await clickToolbarButton("Scripts ON");
    expect(await frameSandbox()).toBe("allow-same-origin");
  });

  it("reuses the tab's view for the next file, which starts with scripts off", async function () {
    await openInActiveTab("Interactive.html");
    await clickToolbarButton("Scripts OFF");
    expect(await frameSandbox()).toBe("allow-scripts");
    await markActiveView();

    await openInActiveTab("Saved/Other page.html");
    // The premise of issue #18: Obsidian keeps the view object.
    expect(await isMarkedView()).toBe(true);
    expect(await frameSandbox()).toBe("allow-same-origin");
  });

  it("shows every line of the file in the source view", async function () {
    await openInActiveTab("Saved/Example article.html");
    await clickToolbarButton("Source");
    const expected = await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getAbstractFileByPath("Saved/Example article.html");
      return file && "extension" in file ? (await app.vault.read(file as never)).split("\n").length : 0;
    });
    const lines = await browser.$$(`${ACTIVE} .html-page-viewer__source-line`);
    expect(lines.length).toBe(expected);
    await saveScreenshot("example-article-source");
    await clickToolbarButton("Rendered");
  });
});
