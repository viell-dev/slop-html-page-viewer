import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resourcePath } from "./support/obsidian";
import { button, frame, Harness, type HtmlView, message, settle } from "./support/harness";

const FIRST = "<!doctype html><title>First</title><p>first original</p>";
const SECOND = "<!doctype html><title>Second</title><p>second original</p>";

/**
 * Holds the next read of `path` until the test completes it, so that the test
 * decides when a refresh's read finishes, without timing.
 */
function holdNextRead(
  harness: Harness,
  path: string,
): { resolve(data: string): void; reject(error: Error): void } {
  const vault = harness.app.vault;
  const read = vault.read;
  const held: { resolve?: (data: string) => void; reject?: (error: Error) => void } = {};
  vault.read = async (file) => {
    if (file.path !== path) return read(file);
    vault.read = read;
    return new Promise<string>((resolve, reject) => Object.assign(held, { resolve, reject }));
  };
  return {
    resolve(data) {
      assert.ok(held.resolve, `the view read ${path}`);
      held.resolve(data);
    },
    reject(error) {
      assert.ok(held.reject, `the view read ${path}`);
      held.reject(error);
    },
  };
}

function shownFile(view: HtmlView): string | null {
  return view.contentEl.querySelector(".html-page-viewer__filename")?.textContent ?? null;
}

/** The text that the source view shows, line by line. */
function shownSource(view: HtmlView): string {
  button(view, "Source").click();
  const lines = [...view.contentEl.querySelectorAll(".html-page-viewer__source-code")];
  button(view, "Rendered").click();
  return lines.map((line) => line.textContent).join("\n");
}

describe("refreshing", () => {
  it("leaves a file that opened in the view meanwhile as it is", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "Review/first.html", FIRST);
    const read = holdNextRead(harness, "Review/first.html");
    button(view, "Refresh preview").click();

    const second = await harness.openFile(view, "Review/second.html", SECOND);
    read.resolve(FIRST);
    await settle();

    assert.equal(view.file?.path, "Review/second.html");
    assert.equal(view.getViewData(), SECOND);
    assert.equal(shownFile(view), "second.html");
    assert.equal(shownSource(view), SECOND);
    assert.ok(frame(view)?.getAttribute("src")?.startsWith(resourcePath(second)));
  });

  it("shows no error for a file that the view has left", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "Review/first.html", FIRST);
    const read = holdNextRead(harness, "Review/first.html");
    button(view, "Refresh preview").click();

    await harness.openFile(view, "Review/second.html", SECOND);
    read.reject(new Error("permission denied"));
    await settle();

    assert.equal(message(view), null);
    assert.equal(shownFile(view), "second.html");
    assert.ok(frame(view), "the second file's page stays");
  });

  it("ignores a read that finishes after the file was opened again", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "Review/first.html", FIRST);
    const read = holdNextRead(harness, "Review/first.html");
    button(view, "Refresh preview").click();

    await harness.openFile(view, "Review/second.html", SECOND);
    await harness.openFile(view, "Review/first.html", "<p>first, newer</p>");
    read.resolve("<p>first, older</p>");
    await settle();

    assert.equal(view.getViewData(), "<p>first, newer</p>");
  });

  it("shows only the latest of two refreshes, whichever read finishes first", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "page.html", FIRST);
    const earlier = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();
    const later = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();

    later.resolve("<p>later</p>");
    await settle();
    earlier.resolve("<p>earlier</p>");
    await settle();
    assert.equal(view.getViewData(), "<p>later</p>");

    // An error from the earlier refresh does not replace the later one's page either.
    const first = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();
    const second = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();
    second.resolve("<p>latest</p>");
    await settle();
    first.reject(new Error("permission denied"));
    await settle();
    assert.equal(message(view), null);
    assert.equal(view.getViewData(), "<p>latest</p>");
    assert.ok(frame(view));
  });

  it("yields to the contents that Obsidian gives the view meanwhile", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "page.html", FIRST);
    const read = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();

    // As when Obsidian sees the file change on disk and loads it again.
    view.setViewData("<p>from Obsidian</p>", false);
    read.resolve("<p>from the refresh</p>");
    await settle();

    assert.equal(view.getViewData(), "<p>from Obsidian</p>");
  });

  it("changes nothing once the view has closed", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "page.html", FIRST);
    const read = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();

    await view.onClose();
    read.resolve("<p>after closing</p>");
    await settle();

    assert.equal(view.contentEl.childElementCount, 0);
    assert.deepEqual(harness.app.writes, []);
  });
});

// The view extends Obsidian's TextFileView, whose saving writes the view's data
// to its file whenever that differs from what the view last read. Those writes
// are Obsidian's code, so the bundle check in policy.test.ts cannot see them;
// these tests run that saving as support/obsidian.ts models it.
describe("Obsidian's saving", () => {
  it("never writes a refreshed view's data to its file", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "page.html", FIRST);
    // The file changed without Obsidian noticing, so only the refresh reads it.
    harness.app.files.set("page.html", "<p>changed on disk</p>");
    button(view, "Refresh preview").click();
    await settle();
    assert.equal(view.getViewData(), "<p>changed on disk</p>");

    view.requestSave();
    assert.equal(view.dirty, false, "Obsidian never takes the view for changed");
    await view.save();
    await view.save(true);
    await harness.openFile(view, "other.html", SECOND);
    await view.onClose();

    assert.deepEqual(harness.app.writes, []);
    assert.equal(harness.app.files.get("page.html"), "<p>changed on disk</p>");
    assert.equal(harness.app.files.get("other.html"), SECOND);
  });

  it("never writes one file's contents into another after a refresh", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "Review/first.html", FIRST);
    const read = holdNextRead(harness, "Review/first.html");
    button(view, "Refresh preview").click();
    await harness.openFile(view, "Review/second.html", SECOND);
    read.resolve(FIRST);
    await settle();

    // As when the tab opens a note, which closes this view.
    await view.onClose();

    assert.deepEqual(harness.app.writes, []);
    assert.equal(harness.app.files.get("Review/second.html"), SECOND);
  });
});
