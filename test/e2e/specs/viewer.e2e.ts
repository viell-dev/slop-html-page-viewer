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

  it("keeps the tab's view mode and theme while the tab shows a note, and not in a new tab", async function () {
    const themeButton = async (): Promise<string> => browser.$(`${ACTIVE} .html-page-viewer__theme-toggle`).getText();
    const showsSource = async (): Promise<boolean> => browser.$(`${ACTIVE} .html-page-viewer__source`).isExisting();
    await openInActiveTab("Saved/Other page.html");
    await clickToolbarButton("Theme ON");
    await clickToolbarButton("Source");

    await openInActiveTab("Notes/Topic.md");
    expect(await activeViewType()).toBe("markdown");
    await openInActiveTab("Saved/Other page.html");
    expect(await activeViewType()).toBe(VIEW_TYPE);
    expect(await showsSource()).toBe(true);
    expect(await themeButton()).toBe("Theme OFF");

    await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getAbstractFileByPath("Saved/Other page.html");
      (window as unknown as { e2eTab: unknown }).e2eTab = app.workspace.getMostRecentLeaf();
      await app.workspace.getLeaf("tab").openFile(file as never, { active: true });
    });
    try {
      expect(await showsSource()).toBe(false);
      expect(await themeButton()).toBe("Theme ON");
    } finally {
      await browser.executeObsidian(({ app }) => {
        app.workspace.getMostRecentLeaf()?.detach();
        const tab = (window as unknown as { e2eTab: Parameters<typeof app.workspace.setActiveLeaf>[0] }).e2eTab;
        app.workspace.setActiveLeaf(tab, { focus: true });
      });
    }
    await clickToolbarButton("Rendered");
    await clickToolbarButton("Theme OFF");
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
