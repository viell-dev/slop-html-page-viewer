import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sandboxValue } from "../src/main";
import { button, frame, Harness, message, sandboxTokens, securityPill, settle } from "./support/harness";

const PAGE = "<!doctype html><title>Report</title><p>Quarterly figures</p>";

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
    assert.equal(page.querySelector("base")?.getAttribute("href"), "app://test-vault/Reports/q3%20report.html");
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
    const policy = page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
    assert.match(policy, /img-src app:\/\/test-vault\/ https: http: data: blob:/);
    assert.equal(page.head.firstElementChild?.tagName, "META", "the policy comes before anything it governs");
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
    harness.open(view, "trusted.html", PAGE);
    button(view, "Scripts OFF").click();

    view.clear();
    view.setViewData(PAGE, false);
    const iframe = frame(view);
    assert.ok(iframe);
    assert.deepEqual(sandboxTokens(iframe), ["allow-same-origin"]);
  });

  it("keeps scripts on while the same file is reloaded", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    harness.open(view, "page.html", PAGE);
    button(view, "Scripts OFF").click();

    // Obsidian passes clear = false when the open file changes on disk.
    view.setViewData("<p>Changed on disk</p>", false);
    let iframe = frame(view);
    assert.ok(iframe);
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
    assert.equal(message(view), "The viewer does not open .md files. Its settings list the extensions it opens as HTML.");
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
    assert.equal(header?.querySelector(".html-page-viewer__path")?.textContent, "Reports/2026/summary.html");
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
