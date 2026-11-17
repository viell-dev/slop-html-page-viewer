// Helpers for driving the plugin's view in Obsidian.

import fs from "node:fs";
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
  return browser.executeObsidian(({ app }) =>
    app.workspace.getMostRecentLeaf()?.view.getViewType(),
  );
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

/** Where the run's screenshots, logs, and diagnoses go, as wdio.conf.mts says. */
function outputDir(): string {
  const root = path.resolve(import.meta.dirname, "../../..");
  return process.env.E2E_OUTPUT_DIR?.trim() || path.join(root, "test-results", "e2e");
}

export async function saveScreenshot(name: string): Promise<void> {
  const version = browser.getObsidianVersion();
  await browser.saveScreenshot(path.join(outputDir(), "screenshots", `${version}-${name}.png`));
}

/** The vault's folder on disk. */
export async function vaultFolder(): Promise<string> {
  return browser.executeObsidian(
    ({ app }) => (app.vault.adapter as unknown as { basePath: string }).basePath,
  );
}

/** The active tab's frame. */
const FRAME = `${ACTIVE} iframe.html-page-viewer__frame`;

/**
 * Waits until the active tab's frame has loaded its page: the `srcdoc` page
 * has replaced the blank document that the frame starts with, and it has
 * loaded, so every file it asked for has been served or refused.
 */
export async function waitForPage(): Promise<void> {
  await browser.$(FRAME).waitForExist();
  let opaque = false;
  await browser.waitUntil(
    async () => {
      const state = await browser.execute((selector) => {
        const frame = document.querySelector<HTMLIFrameElement>(selector);
        if (!frame?.srcdoc) return "none";
        const doc = frame.contentDocument;
        return doc === null ? "opaque" : doc.URL === "about:srcdoc" ? doc.readyState : "none";
      }, FRAME);
      opaque = state === "opaque";
      return opaque ? opaquePageLoaded() : state === "complete";
    },
    { timeout: 20_000, timeoutMsg: "the frame's page did not finish loading" },
  );
  // Then a moment for what it loaded to be painted, before a test counts
  // pixels that a page with scripts on must not show.
  if (opaque) await browser.pause(250);
}

/**
 * Whether the page in the active tab's frame has loaded, asked inside the
 * frame. With scripts on, the window cannot reach the frame's document,
 * whether it is still the blank one or already the page: both are opaque.
 */
async function opaquePageLoaded(): Promise<boolean> {
  await browser.switchFrame(browser.$(FRAME));
  try {
    return await browser.execute(
      () => location.href === "about:srcdoc" && document.readyState === "complete",
    );
  } finally {
    await browser.switchFrame(null);
  }
}

/** How many pixels of the active tab's frame show `color`. */
export async function framePixels(color: Color): Promise<number> {
  const frame = await browser.$(`${ACTIVE} iframe.html-page-viewer__frame`);
  const shot = await browser.takeElementScreenshot(await frame.elementId);
  return decodePng(Buffer.from(shot, "base64")).count(color);
}

/** The frames in Obsidian's window, and the origins its main process records for them. */
export interface RecordedFrames {
  /** How many frames the window's document holds. */
  readonly frames: number;
  /** The origin that Obsidian's main process records for each of its child frames. */
  readonly origins: string[];
}

/**
 * The origins that Obsidian's main process records for the window's frames.
 * It serves vault files to a frame by this origin, not by the one that the
 * frame's page has (#83), so a frame with scripts on must be "null" here.
 */
export async function recordedFrames(): Promise<RecordedFrames> {
  return readRecordedFrames(null);
}

/**
 * Clicks the active tab's toolbar button labelled `label`, and reads
 * {@link recordedFrames} in the same task: the record of the frame that the
 * click renders, before its page commits.
 */
export async function recordedFramesAfterClick(label: string): Promise<RecordedFrames> {
  return readRecordedFrames(label);
}

async function readRecordedFrames(clickFirst: string | null): Promise<RecordedFrames> {
  return browser.execute(
    (active, clickFirst) => {
      if (clickFirst !== null) {
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>(
            `${active} .html-page-viewer__toolbar button`,
          ),
        ].find((candidate) => candidate.textContent === clickFirst);
        if (!button) throw new Error(`No toolbar button labelled ${clickFirst}`);
        button.click();
      }
      // Obsidian exposes Electron's remote module to its window, which reads
      // the main process's objects.
      interface Remote {
        getCurrentWebContents(): { mainFrame: { frames: { origin: string }[] } };
      }
      const load = (window as unknown as { require(name: string): unknown }).require;
      const remote =
        (load("electron") as { remote?: Remote }).remote ?? (load("@electron/remote") as Remote);
      return {
        frames: document.querySelectorAll("iframe").length,
        origins: remote.getCurrentWebContents().mainFrame.frames.map((frame) => frame.origin),
      };
    },
    ACTIVE,
    clickFirst,
  );
}

/**
 * What the active tab shows, for a test that saw what it should not: the
 * view, the plugin's settings, the frames with the origins that the main
 * process records for them, and, from inside the frame, its page and images.
 */
async function frameDiagnosis(): Promise<Record<string, unknown>> {
  const attempt = async (read: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `could not read: ${message.slice(0, 300)}`;
    }
  };
  const view = await attempt(() =>
    browser.executeObsidian(
      ({ app }, active, id) => {
        const leaf = app.workspace.getMostRecentLeaf();
        const view = leaf?.view as { file?: { path: string } | null; getViewType(): string };
        const plugins = (app as unknown as { plugins: { plugins: Record<string, unknown> } })
          .plugins.plugins;
        const security = document.querySelector(`${active} .html-page-viewer__security`);
        return {
          type: view?.getViewType() ?? null,
          file: view?.file?.path ?? null,
          security: security
            ? [...security.children].map((part) => part.textContent ?? "").join(" | ")
            : null,
          settings: (plugins[id] as { settings?: unknown } | undefined)?.settings ?? null,
          frames: [
            ...document.querySelectorAll<HTMLIFrameElement>(
              `${active} iframe.html-page-viewer__frame`,
            ),
          ].map((frame) => ({
            sandbox: frame.getAttribute("sandbox"),
            srcdocLength: frame.srcdoc.length,
            dataUrls: (frame.srcdoc.match(/data:/g) ?? []).length,
            reachable: frame.contentDocument !== null,
          })),
        };
      },
      ACTIVE,
      PLUGIN_ID,
    ),
  );
  const recorded = await attempt(() => recordedFrames());
  const page = await attempt(async () => {
    await browser.switchFrame(browser.$(FRAME));
    try {
      return await browser.execute(() => ({
        origin: self.origin,
        url: location.href,
        readyState: document.readyState,
        images: [...document.images].map((image) => ({
          src: (image.getAttribute("src") ?? "").slice(0, 120),
          complete: image.complete,
          naturalWidth: image.naturalWidth,
        })),
        // Requests that the document made, and when, in milliseconds from its
        // start. Chromium lists some requests and not others, and gives no
        // sizes to a page with an opaque origin, so a missing one proves nothing.
        requested: performance
          .getEntriesByType("resource")
          .slice(0, 50)
          .map((entry) => {
            const timing = entry as PerformanceResourceTiming;
            return {
              name: timing.name.slice(0, 120),
              initiatorType: timing.initiatorType,
              startTime: Math.round(timing.startTime),
              responseEnd: Math.round(timing.responseEnd),
            };
          }),
      }));
    } finally {
      await browser.switchFrame(null);
    }
  });
  return { view, recorded, page };
}

/**
 * Checks that the active tab's frame shows no pixel of `color`. When it does,
 * it saves a diagnosis of the frame among the run's results, waits, and counts
 * again, to tell a page that loaded what it should not from one that had not
 * yet been painted, and fails with both (#83).
 */
export async function expectNoPixels(color: Color, what: string): Promise<void> {
  const seen = await framePixels(color);
  if (seen === 0) return;
  const diagnosis = await frameDiagnosis();
  await browser.pause(1000);
  const later = await framePixels(color).catch(() => null);
  const name = `${browser.getObsidianVersion()}-${what.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const file = path.join(outputDir(), "diagnoses", `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ what, seen, later, ...diagnosis }, null, 2));
  throw new Error(
    `The frame showed ${seen} pixels of ${color.join(",")} (${what}), and ${later} a second ` +
      `later; diagnosis in ${file}: ${JSON.stringify(diagnosis)}`,
  );
}

/** Where a link in the page of the tab that `tab` selects is, once it has stopped moving. */
async function stablePoint(selector: string, tab: string): Promise<{ x: number; y: number }> {
  return browser.executeObsidian(
    async ({ app }, selector, tab) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `${tab} iframe.html-page-viewer__frame`,
      );
      const target = frame?.contentDocument?.querySelector(selector);
      if (!frame || !target) {
        // Say what the tab shows instead, so that a failure in CI tells a page
        // that has not loaded from a tab that has moved on.
        const view = app.workspace.getMostRecentLeaf()?.view as
          { file?: { path: string } | null; getViewType(): string } | undefined;
        const doc = frame?.contentDocument;
        const page = !frame
          ? "no frame"
          : !doc
            ? "a page it cannot reach"
            : `a page with base ${doc.baseURI} (${doc.readyState})`;
        throw new Error(
          `No ${selector} in the page: the tab shows ${view?.getViewType() ?? "nothing"} ` +
            `${view?.file?.path ?? "without a file"}, with ${page}`,
        );
      }
      target.scrollIntoView({ block: "center" });
      const measure = () => {
        const outer = frame.getBoundingClientRect();
        const inner = target.getBoundingClientRect();
        return {
          x: Math.round(outer.left + inner.left + 4),
          y: Math.round(outer.top + inner.top + inner.height / 2),
        };
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
    },
    selector,
    tab,
  );
}

/**
 * Clicks a link in the active tab's page, as a user does, with optional
 * modifier keys, or in the page of the tab in Obsidian's main window that
 * `tab` selects. It checks that the click reached the link, and clicks again
 * when the page moved under the pointer.
 */
export async function clickInPage(
  selector: string,
  modifiers: string[] = [],
  tab = ACTIVE,
): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const point = await stablePoint(selector, tab);
    const before = await activeFile();
    await browser.execute(
      (selector, tab) => {
        const frame = document.querySelector<HTMLIFrameElement>(
          `${tab} iframe.html-page-viewer__frame`,
        );
        const state = window as unknown as { e2eHit?: boolean };
        state.e2eHit = false;
        const record = (event: Event) => {
          state.e2eHit ||= (event.target as Element | null)?.closest?.(selector) != null;
        };
        // The window sees the event before the view's listeners on the document,
        // which may replace the frame while the event is still being delivered.
        frame?.contentWindow?.addEventListener("click", record, true);
        frame?.contentWindow?.addEventListener("auxclick", record, true);
      },
      selector,
      tab,
    );
    if (modifiers.length > 0) await browser.action("key").down(modifiers[0]).perform(true);
    await browser.action("pointer").move(point).down().up().perform();
    if (modifiers.length > 0) await browser.action("key").up(modifiers[0]).perform();
    if (await browser.execute(() => (window as unknown as { e2eHit?: boolean }).e2eHit === true))
      return attempt;
    // The listener misses a click that lands on a frame that replaced the one
    // it watches. If the tab has moved on to another file, the click took
    // effect, and clicking again would look for the link in what replaced the
    // page (#77). Otherwise the page is still there, perhaps loading again.
    try {
      await browser.waitUntil(
        async () => {
          const now = await activeFile();
          return now.path !== before.path || now.type !== before.type;
        },
        { timeout: 1000, interval: 100 },
      );
      return attempt;
    } catch {
      await waitForPage();
    }
  }
  throw new Error(`Three clicks at ${selector} missed it`);
}

/**
 * Moves the active tab to a new tab group beside it, with the calls that
 * Obsidian makes when a tab is dropped on another tab group, or to a new
 * window, as the tab's menu does. Either way Obsidian moves the tab's
 * elements, and the frame drops its document and loads its copy again.
 * Given `width`, the tab's view then has that width, in CSS pixels, before the
 * frame lays out its next document, as a tab group of another width gives it.
 */
export async function moveActiveTab(to: "group" | "window", width?: number): Promise<void> {
  await browser.executeObsidian(
    ({ app }, to, width) => {
      const leaf = app.workspace.getMostRecentLeaf()!;
      const frame = leaf.view.containerEl.querySelector<HTMLIFrameElement>("iframe")!;
      frame.dataset.e2eMoved = "";
      frame.contentDocument!.documentElement.dataset.e2eBefore = "";
      const resize = (): void => {
        if (width !== undefined)
          leaf.view.containerEl
            .querySelector<HTMLElement>(".view-content")
            ?.style.setProperty("width", `${width}px`);
      };
      if (to === "window") {
        app.workspace.moveLeafToPopout(leaf);
        resize();
        return;
      }
      // Not in Obsidian's API types; 1.5.3 and 1.15.1 have them.
      interface Parent {
        children: unknown[];
        removeChild(child: unknown): void;
        insertChild(index: number, child: unknown): void;
        selectTabIndex(index: number): void;
      }
      const moved = leaf as unknown as { parent: Parent; setDimension(size: null): void };
      const split = app.workspace.getLeaf("split", "vertical") as unknown as { parent: Parent };
      moved.parent.removeChild(leaf);
      moved.setDimension(null);
      split.parent.insertChild(-1, leaf);
      split.parent.selectTabIndex(split.parent.children.indexOf(leaf));
      app.workspace.setActiveLeaf(leaf, { focus: true });
      resize();
    },
    to,
    width,
  );
}

/** The active tab's file path and view type. */
export async function activeFile(): Promise<{ path: string | null; type: string | null }> {
  return browser.executeObsidian(({ app }) => {
    const leaf = app.workspace.getMostRecentLeaf();
    const view = leaf?.view as
      { file?: { path: string } | null; getViewType(): string } | undefined;
    return { path: view?.file?.path ?? null, type: view?.getViewType() ?? null };
  });
}
