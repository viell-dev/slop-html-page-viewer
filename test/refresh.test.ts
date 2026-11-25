import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { button, frame, Harness, type HtmlView, message, settle } from "./support/harness";

const FIRST = "<!doctype html><title>First</title><p>first original</p>";
const SECOND = "<!doctype html><title>Second</title><p>second original</p>";

/**
 * Holds the next read of `path` until the test completes it, so that a test
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

/** The text of the page in the view's frame, once the view has prepared it. */
async function shownText(view: HtmlView): Promise<string | null> {
  await settle();
  const iframe = frame(view);
  if (!iframe) return null;
  return new DOMParser().parseFromString(iframe.srcdoc, "text/html").body.textContent;
}

function shownFile(view: HtmlView): string | null {
  return view.contentEl.querySelector(".html-page-viewer__filename")?.textContent ?? null;
}

describe("refreshing", () => {
  it("leaves a file that opened in the view meanwhile as it is", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "Review/first.html", FIRST);
    const read = holdNextRead(harness, "Review/first.html");
    button(view, "Refresh preview").click();

    await harness.openFile(view, "Review/second.html", SECOND);
    read.resolve("<p>stale first</p>");
    await settle();

    assert.equal(view.file?.path, "Review/second.html");
    assert.equal(view.getViewData(), SECOND);
    assert.equal(shownFile(view), "second.html");
    assert.equal(await shownText(view), "second original");
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
    assert.equal(await shownText(view), "second original");
  });

  it("ignores a read that finishes as the view closes, and prepares no page then (#158)", async () => {
    // The read can go on in any of the microtasks in which the file unloads.
    for (let ticks = 0; ticks < 10; ticks++) {
      const harness = await Harness.load();
      const view = harness.newView();
      await harness.openFile(view, "Review/first.html", FIRST);
      const read = holdNextRead(harness, "Review/first.html");
      button(view, "Refresh preview").click();

      read.resolve("<p>stale first</p>");
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
      await view.onClose();
      await settle();

      assert.equal(view.file, null);
      assert.equal(frame(view), null, `${ticks} microtasks before the close`);
    }
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
    assert.equal(await shownText(view), "first, newer");
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
    assert.equal(await shownText(view), "later");

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
    assert.equal(await shownText(view), "latest");
  });

  it("yields to Obsidian's reload of the file after it changed on disk meanwhile", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    const file = await harness.openFile(view, "page.html", FIRST);
    const read = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();

    harness.app.files.set("page.html", "<p>changed on disk</p>");
    harness.app.vault.trigger("modify", file);
    await settle();
    read.resolve("<p>from the refresh</p>");
    await settle();

    assert.equal(view.getViewData(), "<p>changed on disk</p>");
    assert.equal(await shownText(view), "changed on disk");
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

  it("shows the file's current contents, and an error once it cannot be read", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    await harness.openFile(view, "page.html", FIRST);
    const read = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();
    read.resolve("<p>updated</p>");
    await settle();
    assert.equal(view.getViewData(), "<p>updated</p>");
    assert.equal(await shownText(view), "updated");

    const failing = holdNextRead(harness, "page.html");
    button(view, "Refresh preview").click();
    failing.reject(new Error("permission denied"));
    await settle();
    assert.equal(message(view), "Unable to read HTML file: permission denied");
    assert.equal(frame(view), null);
  });
});

// Obsidian's TextFileView loads the view's file again when the vault reports
// that it changed, and gives the view what it read without checking that the
// view still shows that file (support/obsidian.ts).
describe("Obsidian's reload of a changed file (#115)", () => {
  it("shows the file's new contents", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    const file = await harness.openFile(view, "page.html", FIRST);

    harness.app.files.set("page.html", "<p>changed on disk</p>");
    harness.app.vault.trigger("modify", file);
    await settle();

    assert.equal(view.getViewData(), "<p>changed on disk</p>");
    assert.equal(await shownText(view), "changed on disk");
  });

  it("shows the file that the tab shows when the reload's read finishes after another opened", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    const first = await harness.openFile(view, "Review/first.html", FIRST);
    const read = holdNextRead(harness, "Review/first.html");
    harness.app.vault.trigger("modify", first);

    await harness.openFile(view, "Review/second.html", SECOND);
    read.resolve("<p>first, changed on disk</p>");
    await settle();

    assert.equal(view.file?.path, "Review/second.html");
    assert.equal(view.getViewData(), SECOND);
    assert.equal(shownFile(view), "second.html");
    assert.equal(await shownText(view), "second original");
    await view.onClose();
    assert.deepEqual(harness.app.writes, []);
  });

  it("keeps showing the page until the view has read the file itself", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    const first = await harness.openFile(view, "Review/first.html", FIRST);
    const reload = holdNextRead(harness, "Review/first.html");
    harness.app.vault.trigger("modify", first);
    await harness.openFile(view, "Review/second.html", SECOND);

    // The view's own read of the file it shows, held while Obsidian's ends.
    const own = holdNextRead(harness, "Review/second.html");
    reload.resolve("<p>first, changed on disk</p>");
    await settle();
    assert.equal(view.getViewData(), SECOND);
    button(view, "Source").click();
    assert.match(view.contentEl.textContent ?? "", /second original/);
    assert.doesNotMatch(view.contentEl.textContent ?? "", /first, changed on disk/);

    own.resolve(SECOND);
    await settle();
    assert.equal(view.getViewData(), SECOND);
  });

  it("shows no error once the view has closed", async () => {
    const harness = await Harness.load();
    const view = harness.newView();
    const file = await harness.openFile(view, "page.html", FIRST);
    const read = holdNextRead(harness, "page.html");
    harness.app.vault.trigger("modify", file);

    await view.onClose();
    read.resolve("<p>changed on disk</p>");
    await settle();

    assert.equal(view.contentEl.childElementCount, 0);
    assert.deepEqual(harness.app.writes, []);
  });
});

// The view extends Obsidian's TextFileView, whose saving writes the view's data
// to its file whenever that differs from what the view last read. The bundle
// check in policy.test.ts cannot see those writes, which Obsidian's own code
// makes; these tests model that saving (support/obsidian.ts), and
// test/e2e/specs/read-only.e2e.ts checks it in Obsidian.
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

  it("never writes a file when the view leaves it after a refresh it no longer owns", async () => {
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
