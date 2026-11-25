import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sandboxValue } from "../src/view";
import {
  button,
  frame,
  Harness,
  type HtmlView,
  message,
  sandboxTokens,
  securityPill,
  settle,
} from "./support/harness";

const PAGE = "<!doctype html><title>Report</title><p>Quarterly figures</p>";

/** The view mode buttons that say they are pressed; every one says whether it is. */
function pressedModes(view: HtmlView): string[] {
  return ["Rendered", "Source", "Split"].filter((mode) => {
    const pressed = button(view, mode).getAttribute("aria-pressed");
    assert.ok(pressed === "true" || pressed === "false", `${mode} says whether it is pressed`);
    return pressed === "true";
  });
}

describe("rendered view", () => {
  it("renders a copy of the page whose references resolve from the file's folder", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Reports/q3 report.html", PAGE);

    const iframe = frame(view);
    assert.ok(iframe, "the view shows a frame");
    assert.equal(iframe.getAttribute("src"), null, "the frame does not load the file itself");
    await settle();
    const page = new DOMParser().parseFromString(iframe.srcdoc, "text/html");
    assert.equal(
      page.querySelector("base")?.getAttribute("href"),
      "app://test-vault/Reports/q3%20report.html",
    );
    assert.equal(page.querySelector("p")?.textContent, "Quarterly figures");
    assert.match(iframe.srcdoc, /^<!DOCTYPE html>/);
    assert.equal(iframe.getAttribute("title"), "q3 report.html");
    assert.equal(iframe.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(view.getDisplayText(), "q3 report");
  });

  it("limits the copy's vault resources to the vault", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Reports/page.html", PAGE);
    await settle();

    const iframe = frame(view);
    assert.ok(iframe);
    const page = new DOMParser().parseFromString(iframe.srcdoc, "text/html");
    const policy =
      page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ??
      "";
    assert.match(policy, /img-src app:\/\/test-vault\/ https: http: data: blob:/);
    assert.equal(
      page.head.firstElementChild?.tagName,
      "META",
      "the policy comes before anything it governs",
    );
  });
  it("starts with scripts off", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);

    const iframe = frame(view);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-same-origin"]);
    assert.equal(securityPill(view), "Scripts OFF");
    assert.equal(button(view, "Scripts OFF").getAttribute("aria-pressed"), "false");
  });

  it("grants only allow-scripts when scripts are turned on, and revokes it when turned off", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);

    button(view, "Scripts OFF").click();
    let iframe = frame(view);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-scripts"]);
    assert.equal(securityPill(view), "Scripts ON");
    assert.equal(button(view, "Scripts ON").getAttribute("aria-pressed"), "true");

    button(view, "Scripts ON").click();
    iframe = frame(view);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-same-origin"]);
    assert.equal(securityPill(view), "Scripts OFF");
  });

  it("gives each frame its sandbox before the frame joins the document (#83)", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    // A frame changed after it joined the view's content shows up as an
    // attribute record; one created with its sandbox never does.
    const records: MutationRecord[] = [];
    const observer = new window.MutationObserver((list) => records.push(...list));
    observer.observe(view.contentEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["sandbox"],
    });
    harness.open(view, "page.html", PAGE);
    button(view, "Scripts OFF").click();
    button(view, "Scripts ON").click();
    await settle();
    records.push(...observer.takeRecords());
    observer.disconnect();

    const added = new Set(
      records
        .flatMap((record) => [...record.addedNodes])
        .flatMap((node) =>
          node instanceof window.HTMLIFrameElement
            ? [node]
            : node instanceof window.Element
              ? [...node.querySelectorAll("iframe")]
              : [],
        ),
    );
    assert.deepEqual(
      [...added].map((frame) => frame.getAttribute("sandbox")),
      [sandboxValue(false), sandboxValue(true), sandboxValue(false)],
      "a frame for the page, with scripts on, and with them off",
    );
    assert.deepEqual(
      records.filter((record) => record.type === "attributes").map((record) => record.target),
      [],
      "no frame's sandbox changed after it was inserted",
    );
  });

  it("opens the copy's shadow roots and makes it inert until watched only with scripts off", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(
      view,
      "page.html",
      `<div><template shadowrootmode="closed"><a href="other.html">Other</a></template></div>`,
    );
    await settle();
    const copy = (): Document => {
      const iframe = frame(view);
      assert.ok(iframe);
      return new DOMParser().parseFromString(iframe.srcdoc, "text/html");
    };
    const state = (page: Document) => ({
      mode: page.querySelector("template")?.getAttribute("shadowrootmode"),
      inert: page.documentElement.hasAttribute("inert"),
    });
    // With scripts off, the view follows the page's links and makes it act.
    assert.deepEqual(state(copy()), { mode: "open", inert: true });

    // With scripts on, the view cannot reach the page, whose own scripts may
    // depend on the declared mode.
    button(view, "Scripts OFF").click();
    await settle();
    assert.deepEqual(state(copy()), { mode: "closed", inert: false });

    button(view, "Scripts ON").click();
    await settle();
    assert.deepEqual(state(copy()), { mode: "open", inert: true });
  });

  it("never grants scripts together with same-origin access, nor forms, popups, or navigation", () => {
    for (const scriptsEnabled of [false, true]) {
      const tokens = sandboxValue(scriptsEnabled).split(/\s+/).filter(Boolean);
      const label = `sandbox with scripts ${scriptsEnabled ? "on" : "off"}`;
      assert.deepEqual(tokens, scriptsEnabled ? ["allow-scripts"] : ["allow-same-origin"], label);
      assert.ok(!(tokens.includes("allow-scripts") && tokens.includes("allow-same-origin")), label);
    }
  });
  it("keeps scripts per view: a new tab starts with them off", async () => {
    const harness = await Harness.load();
    const first = harness.newView();
    harness.open(first, "first.html", PAGE);
    button(first, "Scripts OFF").click();

    const second = harness.newView();
    harness.open(second, "second.html", PAGE);
    const iframe = frame(second);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-same-origin"]);
  });

  it("turns scripts off when another file opens in the same view", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "trusted.html", PAGE);
    button(view, "Scripts OFF").click();

    harness.open(view, "other.html", PAGE);
    const iframe = frame(view);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-same-origin"]);
    assert.equal(securityPill(view), "Scripts OFF");
  });

  it("turns scripts off when the view is cleared", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    const file = harness.open(view, "trusted.html", PAGE);
    button(view, "Scripts OFF").click();

    view.clear();
    // Obsidian reloads the file when it changes on disk.
    harness.app.vault.trigger("modify", file);
    await settle();
    const iframe = frame(view);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-same-origin"]);
  });

  it("keeps scripts on while the same file is reloaded", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    const file = harness.open(view, "page.html", PAGE);
    button(view, "Scripts OFF").click();
    const before = frame(view);

    harness.app.files.set("page.html", "<p>Changed on disk</p>");
    harness.app.vault.trigger("modify", file);
    await settle();
    let iframe = frame(view);
    assert.ok(iframe);
    assert.notEqual(iframe, before);
    assert.match(iframe.srcdoc, /Changed on disk/);
    assert.deepEqual(sandboxTokens(iframe), ["allow-scripts"]);

    button(view, "Refresh preview").click();
    await settle();
    iframe = frame(view);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-scripts"]);
  });

  it("keeps the view mode when another file opens in the same view", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "first.html", PAGE);
    button(view, "Source").click();

    harness.open(view, "second.html", PAGE);
    assert.equal(frame(view), null);
    assert.ok(view.contentEl.querySelector(".html-page-viewer__source"));
  });

  it("keeps the tab's view mode and theme while the tab shows a note", async () => {
    const harness = await Harness.load();
    const before = harness.newView();
    harness.open(before, "first.html", PAGE);
    button(before, "Theme ON").click();
    button(before, "Source").click();
    button(before, "Scripts OFF").click();

    // A note replaced the view; this view is the tab's next HTML file.
    const after = harness.newView(before.leaf);
    harness.open(after, "second.html", PAGE);
    assert.ok(after.contentEl.querySelector(".html-page-viewer__source"));
    assert.equal(button(after, "Theme OFF").getAttribute("aria-pressed"), "false");
    assert.equal(securityPill(after), "Scripts OFF");
  });

  it("starts a new tab rendered, with the theme on", async () => {
    const harness = await Harness.load();
    const first = harness.newView();
    harness.open(first, "first.html", PAGE);
    button(first, "Theme ON").click();
    button(first, "Source").click();

    const second = harness.newView();
    harness.open(second, "second.html", PAGE);
    assert.ok(frame(second));
    assert.equal(button(second, "Theme ON").getAttribute("aria-pressed"), "true");
  });

  it("says which view mode is selected, in a labelled group of buttons (#96)", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    const group = view.contentEl.querySelector(".html-page-viewer__segmented");
    assert.equal(group?.getAttribute("role"), "group");
    assert.equal(group?.getAttribute("aria-label"), "View mode");
    assert.deepEqual(pressedModes(view), ["Rendered"]);

    for (const mode of ["Source", "Split", "Rendered"]) {
      button(view, mode).click();
      assert.deepEqual(pressedModes(view), [mode], `after choosing ${mode}`);
      assert.ok(button(view, mode).classList.contains("is-active"), "it shows as selected too");
    }
  });

  it("says which view mode the tab keeps for its next page (#96)", async () => {
    const harness = await Harness.load();
    const before = harness.newView();
    harness.open(before, "first.html", PAGE);
    button(before, "Split").click();

    harness.open(before, "second.html", PAGE);
    assert.deepEqual(pressedModes(before), ["Split"]);
    // A note replaced the view; this view is the tab's next HTML file.
    const after = harness.newView(before.leaf);
    harness.open(after, "third.html", PAGE);
    assert.deepEqual(pressedModes(after), ["Split"]);
    const other = harness.newView();
    harness.open(other, "fourth.html", PAGE);
    assert.deepEqual(pressedModes(other), ["Rendered"]);
  });

  it("reloads the file and the frame when refreshed", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    const before = frame(view);
    harness.app.files.set("page.html", "<p>Updated</p>");

    button(view, "Refresh preview").click();
    await settle();

    assert.deepEqual(harness.app.reads, ["page.html"]);
    assert.equal(view.getViewData(), "<p>Updated</p>");
    const after = frame(view);
    assert.ok(after);
    assert.notEqual(after, before, "the frame is replaced");
  });

  it("reports a file that cannot be read when refreshed", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    harness.app.readError = new Error("permission denied");

    button(view, "Refresh preview").click();
    await settle();

    assert.equal(message(view), "Unable to read HTML file: permission denied");
    assert.equal(frame(view), null);
  });
});

describe("text tracks with scripts off (#196)", () => {
  it("are not copied into the page, whose CSS could read a copy, only with scripts on", async () => {
    // With scripts off, no script runs, but CSS does: an attribute selector
    // could test a copied data: URL piece by piece and signal it to the web.
    const harness = await Harness.load({ copyLocalFiles: true });
    harness.app.files.set("Saved/subs.vtt", "WEBVTT");
    const view = harness.newView();
    harness.open(view, "Saved/Clip.html", `<video><track default src="subs.vtt"></video>`);
    await settle();
    const shown = () => new DOMParser().parseFromString(frame(view)!.srcdoc, "text/html");
    assert.equal(shown().querySelector("track")?.getAttribute("src"), "subs.vtt");
    assert.deepEqual(harness.app.binaryReads, []);

    button(view, "Scripts OFF").click();
    await settle();
    assert.deepEqual(sandboxTokens(frame(view)!), ["allow-scripts"]);
    assert.equal(
      shown().querySelector("track")?.getAttribute("src"),
      `data:text/vtt;base64,${btoa("WEBVTT")}`,
    );
    assert.deepEqual(harness.app.binaryReads, ["Saved/subs.vtt"]);
  });
});

describe("pages that cannot be prepared", () => {
  function policy(iframe: HTMLIFrameElement): string | null {
    const page = new DOMParser().parseFromString(iframe.srcdoc, "text/html");
    return (
      page.head
        .querySelector(':scope > meta[http-equiv="Content-Security-Policy"]:first-child')
        ?.getAttribute("content") ?? null
    );
  }

  function sourceText(view: HtmlView): string {
    return [...view.contentEl.querySelectorAll(".html-page-viewer__source-code")]
      .map((line) => line.textContent)
      .join("\n");
  }

  it("shows a page whose CSS escapes name no character with the vault policy", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", `<style>p { background: url(\\110000.png) }</style><p>x</p>`);
    await settle();

    const iframe = frame(view);
    assert.ok(iframe);
    assert.match(policy(iframe) ?? "", /img-src app:\/\/test-vault\/ /);
  });

  it("leaves out a linked stylesheet that cannot be read, and shows the page with the vault policy", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.app.files.set("style.css", "p { color: green }");
    harness.app.vault.cachedRead = () => Promise.reject(new Error("synthetic read failure"));
    harness.open(view, "page.html", `<link rel="stylesheet" href="style.css"><p>x</p>`);
    await settle();

    const iframe = frame(view);
    assert.ok(iframe);
    assert.match(policy(iframe) ?? "", /img-src app:\/\/test-vault\/ /);
    assert.doesNotMatch(iframe.srcdoc, /color: green/);
  });

  it("shows an error instead of the page, and recovers on refresh", async (t) => {
    const logged = t.mock.method(console, "error", () => undefined);
    const harness = await Harness.load();
    const view = harness.newView();
    const locate = harness.app.metadataCache.getFirstLinkpathDest;
    harness.app.metadataCache.getFirstLinkpathDest = () => {
      throw new Error("synthetic failure");
    };
    const data = `<!doctype html>\n<p>Kept text</p>\n<img src="missing.png">`;
    harness.open(view, "page.html", data);
    await settle();

    assert.equal(frame(view), null, "the page is not shown without its protections");
    assert.equal(
      message(view),
      "Unable to prepare this page, so it is not shown: synthetic failure",
    );
    assert.equal(logged.mock.callCount(), 1);
    assert.ok(button(view, "Refresh preview"), "the toolbar stays");

    button(view, "Split").click();
    await settle();
    assert.equal(frame(view), null);
    assert.equal(sourceText(view), data, "the source keeps the file's text");
    assert.ok(view.contentEl.querySelector(".html-page-viewer__split .html-page-viewer__message"));

    button(view, "Source").click();
    assert.equal(sourceText(view), data);

    button(view, "Rendered").click();
    harness.app.metadataCache.getFirstLinkpathDest = locate;
    button(view, "Refresh preview").click();
    await settle();
    const iframe = frame(view);
    assert.ok(iframe, "the page shows once it can be prepared");
    assert.match(policy(iframe) ?? "", /img-src app:\/\/test-vault\/ /);
    assert.equal(message(view), null);
  });

  it("shows the error's text as text", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const harness = await Harness.load();
    const view = harness.newView();
    harness.app.metadataCache.getFirstLinkpathDest = () => {
      throw new Error("<img id=probe>");
    };
    harness.open(view, "page.html", `<img src="missing.png">`);
    await settle();

    assert.equal(message(view), "Unable to prepare this page, so it is not shown: <img id=probe>");
    assert.equal(view.contentEl.querySelector("#probe"), null);
  });

  it("shows an error instead of a page with scripts on that copies local files", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const harness = await Harness.load({ scriptsOn: true, copyLocalFiles: true });
    const view = harness.newView();
    harness.app.metadataCache.getFirstLinkpathDest = () => {
      throw new Error("synthetic failure");
    };
    harness.open(view, "page.html", `<p>x</p><img src="missing.png">`);
    await settle();

    assert.equal(frame(view), null, "the page is not shown without its protections");
    assert.equal(
      message(view),
      "Unable to prepare this page, so it is not shown: synthetic failure",
    );
  });

  it("leaves the next page alone when an earlier page's preparation fails late", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const harness = await Harness.load();
    const view = harness.newView();
    harness.app.files.set("style.css", "");
    const read = harness.app.vault.cachedRead;
    let finish: (css: string) => void = () => undefined;
    harness.app.vault.cachedRead = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });
    harness.open(view, "first.html", `<link rel="stylesheet" href="style.css"><p>first</p>`);
    await settle();

    harness.app.vault.cachedRead = read;
    harness.open(view, "second.html", `<p>second</p>`);
    await settle();
    // The first page's stylesheet arrives now, and resolving the image it names fails.
    let failed = false;
    harness.app.metadataCache.getFirstLinkpathDest = () => {
      failed = true;
      throw new Error("late failure");
    };
    finish("p { background: url(missing.png) }");
    await settle();

    assert.ok(failed, "the first page's preparation failed after the second page opened");
    assert.equal(message(view), null);
    assert.match(frame(view)?.srcdoc ?? "", /second/);
  });
});

describe("view messages", () => {
  it("says when no file is attached", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    view.setViewData(PAGE, true);
    assert.equal(message(view), "No HTML file is attached to this viewer.");
    assert.equal(frame(view), null);
  });

  it("refuses files whose extension it does not open", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "notes.md", "# Notes");
    assert.equal(
      message(view),
      "The viewer does not open .md files. Its settings list the extensions it opens as HTML.",
    );
    assert.equal(frame(view), null);
  });

  it("says when the file is empty", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "empty.htm", "  \n\t\n");
    assert.equal(message(view), "This HTML file is empty.");
    assert.equal(frame(view), null);
  });

  it("accepts .htm and upper-case extensions", async () => {
    const harness = await Harness.load();
    for (const path of ["page.htm", "PAGE.HTML"]) {
      const view = harness.newView();
      harness.open(view, path, PAGE);
      assert.ok(frame(view), path);
    }
  });

  it("shows the file's name and path above the page", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "Reports/2026/summary.html", PAGE);
    const header = view.contentEl.querySelector(".html-page-viewer__header");
    assert.equal(header?.querySelector(".html-page-viewer__filename")?.textContent, "summary.html");
    assert.equal(
      header?.querySelector(".html-page-viewer__path")?.textContent,
      "Reports/2026/summary.html",
    );
  });

  it("clears the view", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    view.clear();
    assert.equal(view.getViewData(), "");
    assert.equal(view.contentEl.childElementCount, 0);
  });
});
