import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import "./support/dom";
import { cssReferences, cssTokens, scanReferences, scanTokens } from "../src/css";
import { type PageContext, preparePage } from "../src/document";
import { finish, StoppedError, type Steps, Turns } from "../src/turns";
import { frame, Harness, message, settle } from "./support/harness";

const VAULT = "app://vault-id/vault/";
const RULE = `a:hover { color: red; background: url(img.png); content: "text" } /* text */\n`;
/** Ordinary rules of a hundred thousand tokens or so: twenty-odd looks at the clock. */
const LARGE = RULE.repeat(4_000);

/** Makes each look at the clock find that a slice has run long enough. */
function hurryClock(t: TestContext): void {
  let now = 0;
  t.mock.method(performance, "now", () => (now += 1_000));
}

/** How many tasks of the window ran while `work` did: each turn that it gave lets some run. */
async function tasksDuring(work: () => Promise<unknown>): Promise<number> {
  let tasks = 0;
  let done = false;
  const count = (): void => {
    if (done) return;
    tasks += 1;
    setImmediate(count);
  };
  setImmediate(count);
  try {
    await work();
  } finally {
    done = true;
  }
  return tasks;
}

function context(files: Record<string, string>): PageContext & { reads: string[] } {
  const reads: string[] = [];
  return {
    pageUrl: `${VAULT}Saved/page.html`,
    vaultUrl: VAULT,
    reads,
    async read(path) {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

describe("turns for the window (#158)", () => {
  function* steps(count: number, work: number): Steps<string> {
    for (let i = 0; i < count; i++) yield work;
    return "done";
  }

  it("does work in steps to its end, at once or with turns", async (t) => {
    assert.equal(finish(steps(10, 4096)), "done");
    hurryClock(t);
    assert.equal(await new Turns().run(steps(10, 4096)), "done");
  });

  it("gives the window turns only after a slice of time and much work", async (t) => {
    const during = (count: number, work: number) =>
      tasksDuring(() => new Turns().run(steps(count, work)));
    // The clock stands still: no slice ends, however much work there is.
    t.mock.method(performance, "now", () => 0);
    assert.equal(await during(100, 100_000), 0);
    t.mock.reset();
    // Every slice has run long enough, but little work never looks at the clock.
    hurryClock(t);
    assert.equal(await during(40, 100), 0);
    const tasks = await during(41 * 100, 100);
    assert.ok(tasks >= 50, `${tasks} tasks during a hundred turns`);
  });

  it("starts a slice anew after each turn", async (t) => {
    // Each look at the clock comes 10 ms after the last, as do those that
    // start a slice, so that every third look ends one.
    let now = 0;
    const turns = new Turns();
    t.mock.method(performance, "now", () => (now += 10));
    let given = 0;
    const give = turns.give.bind(turns);
    t.mock.method(turns, "give", () => {
      given += 1;
      return give();
    });
    await turns.give();
    await turns.run(steps(30, 4096));
    assert.equal(given, 11);
  });

  it("ends work that is no longer wanted after a turn", async (t) => {
    hurryClock(t);
    let done = 0;
    function* counted(): Steps<void> {
      for (let i = 0; i < 10; i++) {
        done += 1;
        yield 4096;
      }
    }
    await assert.rejects(new Turns(() => done >= 3).run(counted()), StoppedError);
    assert.equal(done, 3);
  });

  it("scans CSS in steps as at once", async (t) => {
    hurryClock(t);
    const turns = new Turns();
    const tokens = await turns.run(scanTokens(LARGE));
    assert.deepEqual(tokens, cssTokens(LARGE));
    assert.deepEqual(await turns.run(scanReferences(tokens)), cssReferences(tokens));
    const work = (steps: Steps<unknown>) => [...steps].reduce((sum, step) => sum + step, 0);
    for (const scan of [scanTokens(LARGE), scanReferences(tokens)])
      assert.ok(Math.abs(work(scan) - tokens.length) < 1024);
  });
});

describe("preparing a page with turns for the window (#158)", () => {
  const images = `<img src="img.png"><a href="other.html">Other</a>`.repeat(500);
  const pages: Record<string, { html: string; files?: Record<string, string>; copy?: true }> = {
    "a large linked stylesheet": {
      html: `<link rel="stylesheet" href="large.css">`,
      files: { "Saved/large.css": LARGE },
    },
    "a large imported stylesheet": {
      html: `<style>@import "large.css";</style>`,
      files: { "Saved/large.css": LARGE },
    },
    "a large <style>": { html: `<style>${LARGE}</style>` },
    "a large stylesheet that the end leaves open": {
      html: `<link rel="stylesheet" href="large.css">`,
      files: { "Saved/large.css": `@media screen { ${LARGE}` },
    },
    "many images and links": { html: images },
    "many style attributes": {
      html: `<p style="background: url(img.png)">Text</p>`.repeat(500),
    },
    "copying the files of many images, of a large <style>, and of many style attributes": {
      html: `${images}<style>${LARGE}</style>${`<p style="background: url(img.png)"></p>`.repeat(500)}`,
      copy: true,
    },
  };

  for (const [what, { html, files = {}, copy }] of Object.entries(pages)) {
    it(`prepares ${what} the same, and gives the window turns`, async (t) => {
      const prepare = () =>
        preparePage(html, context(files), {
          copyFiles: copy && {
            size: () => 1,
            readBinary: () => Promise.resolve(new Uint8Array([1]).buffer),
          },
        });
      t.mock.method(performance, "now", () => 0);
      const atOnce = await prepare();
      t.mock.reset();
      hurryClock(t);
      let prepared = atOnce;
      const tasks = await tasksDuring(async () => {
        prepared = await prepare();
      });
      assert.equal(prepared.html, atOnce.html);
      assert.ok(tasks >= 3, `${tasks} tasks`);
    });
  }

  it("ends once the page is no longer wanted, and reads no further stylesheet", async (t) => {
    hurryClock(t);
    const ctx = context({ "Saved/large.css": LARGE, "Saved/next.css": "p {}" });
    const html = `<link rel="stylesheet" href="large.css"><link rel="stylesheet" href="next.css">`;
    await assert.rejects(preparePage(html, ctx, { stopped: () => true }), StoppedError);
    assert.deepEqual(ctx.reads, ["Saved/large.css"]);
  });

  it("ends when the view shows another file, without an error", async (t) => {
    hurryClock(t);
    const logged = t.mock.method(console, "error", () => undefined);
    const harness = await Harness.load();
    const reads: string[] = [];
    const read = harness.app.vault.cachedRead;
    harness.app.vault.cachedRead = (file) => {
      reads.push(file.path);
      return read(file);
    };
    harness.app.files.set("large.css", LARGE);
    harness.app.files.set("next.css", "p {}");
    const view = harness.newView();
    const links = `<link rel="stylesheet" href="large.css"><link rel="stylesheet" href="next.css">`;
    harness.open(view, "large.html", links);
    await settle();
    assert.equal(frame(view)?.srcdoc, "", "preparing it has given the window a turn");
    harness.open(view, "other.html", "<p>Other</p>");
    for (let i = 0; i < 100; i++) await settle();
    assert.deepEqual(reads, ["large.css"]);
    assert.match(frame(view)?.srcdoc ?? "", /<p>Other<\/p>/);
    assert.equal(message(view), null);
    assert.equal(logged.mock.callCount(), 0);
  });

  it("shows the page once it is prepared, however many turns that took", async (t) => {
    hurryClock(t);
    const harness = await Harness.load();
    harness.app.files.set("large.css", LARGE);
    const view = harness.newView();
    harness.open(view, "large.html", `<link rel="stylesheet" href="large.css"><p>Large</p>`);
    for (let i = 0; i < 1_000 && frame(view)?.srcdoc === ""; i++) await settle();
    assert.match(frame(view)?.srcdoc ?? "", /<p>Large<\/p>/);
  });
});
