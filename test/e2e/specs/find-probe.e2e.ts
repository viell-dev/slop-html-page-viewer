// A probe for #13, removed by the next commit: what a find bar and a split
// view can use in Obsidian.

import { browser } from "@wdio/globals";
import type { Color } from "../support/pixels.ts";
import { clickToolbarButton, framePixels, openInActiveTab, waitForPage } from "../support/viewer.ts";

const PURPLE: Color = [106, 27, 154];

describe("Probe: a find bar and a split view (#13)", function () {
  it("measures", async function () {
    const version = browser.getObsidianVersion();
    await openInActiveTab("Saved/Example article.html");
    await waitForPage();

    const apis = await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
      const inner = frame?.contentWindow as (Window & typeof globalThis) | null;
      return {
        mainHighlight: typeof Highlight,
        mainRegistry: typeof CSS.highlights,
        frameHighlight: typeof inner?.Highlight,
        frameRegistry: typeof inner?.CSS?.highlights,
      };
    });
    console.log(`PROBE ${version} | highlight API ${JSON.stringify(apis)}`);

    // A highlight over the page's heading, styled by a style element added to the frame's page.
    const marked = await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>(".workspace-leaf.mod-active iframe.html-page-viewer__frame");
      const inner = frame?.contentWindow as (Window & typeof globalThis) | null;
      const doc = frame?.contentDocument;
      const heading = doc?.querySelector("h1");
      if (!inner || !doc || !heading) return "no page";
      const style = doc.createElement("style");
      style.textContent = "::highlight(probe) { background-color: rgb(106, 27, 154); color: rgb(106, 27, 154); }";
      doc.head.append(style);
      const range = doc.createRange();
      range.selectNodeContents(heading);
      inner.CSS.highlights.set("probe", new inner.Highlight(range));
      return "marked";
    });
    await browser.pause(300);
    console.log(`PROBE ${version} | highlight in the page ${marked}: ${await framePixels(PURPLE)} purple pixels`);

    // The view's own scope for Mod+F, and a keydown listener on its content as the alternative.
    const scope = await browser.executeObsidian(({ app, obsidian }) => {
      const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
        scope?: unknown;
        contentEl: HTMLElement;
      };
      const state = window as unknown as { probeScope?: number; probeKeydown?: number };
      state.probeScope = 0;
      state.probeKeydown = 0;
      const before = view.scope === undefined ? "undefined" : view.scope === null ? "null" : "set";
      const scope = new obsidian.Scope(app.scope);
      scope.register(["Mod"], "f", () => {
        state.probeScope = (state.probeScope ?? 0) + 1;
        return false;
      });
      view.scope = scope;
      view.contentEl.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "f") state.probeKeydown = (state.probeKeydown ?? 0) + 1;
      });
      view.contentEl.tabIndex = -1;
      return before;
    });
    // Focus the view's content, as a click on the source view would, then press Ctrl+F.
    await clickToolbarButton("Source");
    await browser.execute(() => document.querySelector<HTMLElement>(".workspace-leaf.mod-active .view-content")?.focus());
    await browser.keys(["Control", "f"]);
    await browser.pause(300);
    const counts = await browser.execute(() => {
      const state = window as unknown as { probeScope?: number; probeKeydown?: number };
      return {
        scope: state.probeScope,
        keydown: state.probeKeydown,
        active: document.activeElement?.className ?? null,
        search: document.querySelector(".document-search-container") !== null,
      };
    });
    console.log(`PROBE ${version} | view.scope before: ${scope} | Ctrl+F in the focused view: ${JSON.stringify(counts)}`);
    await clickToolbarButton("Rendered");
  });
});
