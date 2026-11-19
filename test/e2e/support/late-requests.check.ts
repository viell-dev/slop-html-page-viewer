// Checks late-requests.ts without Obsidian (#170). Tests in Mocha, wrapped by @wdio/utils as
// @wdio/mocha-framework wraps them, with the configuration's beforeTest and afterTest, drive a
// stand-in browser. It sends each request as webdriver 10 does: its "command" event, then
// transformRequest, which may refuse it, then its "result" event once it has its answer or fails.
// session.sh runs it with `node --test` before the tests in Obsidian.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { wrapGlobalTestMethod } from "@wdio/utils";
import Mocha from "mocha";
import {
  checkScope,
  endTestCode,
  refuseLateRequest,
  scopeRunnables,
  watchRequests,
} from "./late-requests.ts";

/** What the stand-in browser and the hooks did, in order. */
const events: string[] = [];
const browser = new EventEmitter();

/** A WebDriver request that has its answer after `ms`, unless the run refuses it. */
function request(command: string, ms: number): Promise<void> {
  browser.emit("command", { command });
  try {
    refuseLateRequest();
  } catch (error) {
    events.push(`refused ${command}`);
    return Promise.reject(error).finally(() =>
      browser.emit("result", { command, result: { error } }),
    );
  }
  events.push(`sent ${command}`);
  return new Promise((resolve) => setTimeout(resolve, ms)).then(() => {
    events.push(`answered ${command}`);
    browser.emit("result", { command, result: {} });
  });
}

/** How long the failure screenshot of the next test takes. */
let screenshotMs = 0;

interface Outcome {
  failures: Map<string, string>;
  passes: string[];
  logged: string[];
}

async function runTests(): Promise<Outcome> {
  scopeRunnables();
  watchRequests(browser as unknown as WebdriverIO.Browser);
  const outcome: Outcome = { failures: new Map(), passes: [], logged: [] };
  const mocha = new Mocha({ ui: "bdd", timeout: 300 });
  mocha.reporter(
    class extends Mocha.reporters.Base {
      constructor(runner: Mocha.Runner) {
        super(runner);
        runner.on("fail", (runnable, error: Error) =>
          outcome.failures.set(runnable.fullTitle(), error.message),
        );
        runner.on("pass", (runnable) => outcome.passes.push(runnable.fullTitle()));
      }
    },
  );
  mocha.suite.emit("pre-require", globalThis, "", mocha);
  // As @wdio/mocha-framework passes them, and as in wdio.conf.mts.
  const hookArgs = (context: unknown): [unknown, unknown] => {
    const { test } = context as Mocha.Context;
    return [{ ...test, parent: test?.parent?.title }, context];
  };
  const beforeTest = (_test: unknown, context: Mocha.Context) => checkScope(context.test);
  const afterTest = (
    _test: unknown,
    _context: unknown,
    result: { passed: boolean; error?: unknown },
  ) =>
    endTestCode(result.error, async () => {
      if (result.passed) return;
      events.push("afterTest");
      await request("takeScreenshot", screenshotMs).catch(() => undefined);
    });
  wrapGlobalTestMethod(true, beforeTest, hookArgs, afterTest, hookArgs, "it", "0-0");
  for (const name of ["before", "after", "beforeEach", "afterEach"])
    wrapGlobalTestMethod(false, [], hookArgs, [], hookArgs, name, "0-0");

  describe("between short requests", function () {
    before(() => {
      screenshotMs = 250;
    });
    afterEach(() => request("cleanup", 10));
    it("times out", async function () {
      // Bounded, so that the check fails rather than hangs when nothing stops it.
      for (let i = 0; i < 30; i++) await request(`step${i}`, 60);
    });
    it("runs next", () => request("next", 10));
  });

  describe("during a long request", function () {
    before(() => {
      screenshotMs = 50;
    });
    afterEach(() => request("cleanup after long", 10));
    it("times out", async function () {
      await request("long", 500);
      await request("after long", 10);
    });
  });

  describe("after it passes", function () {
    let late: Promise<unknown> = Promise.resolve();
    it("leaves code running", function () {
      const runnable = this.test!;
      late = (async () => {
        while (runnable.state === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
        await request("late", 10).catch(() => undefined);
        await request("later", 10).catch(() => undefined);
      })();
    });
    it("waits for that code", () => late);
  });

  const consoleError = console.error;
  console.error = (...args: unknown[]) => outcome.logged.push(args.join(" "));
  try {
    await new Promise<void>((resolve) => mocha.run(() => resolve()));
  } finally {
    console.error = consoleError;
  }
  return outcome;
}

test("a test's code cannot send requests once the test has its result", async () => {
  const { failures, passes, logged } = await runTests();
  const trace = events.join(", ");
  const at = (event: string) => {
    const index = events.indexOf(event);
    assert.ok(index >= 0, `${event} in ${trace}`);
    return index;
  };

  // The test that times out between short requests sends none from the start of afterTest, while
  // the screenshot goes through, and its failure says so.
  const steps = events.filter((event) => /^(sent|refused) step/.test(event));
  const refused = steps.findIndex((event) => event.startsWith("refused"));
  assert.ok(refused > 0, trace);
  assert.equal(steps.length, refused + 1, trace);
  assert.ok(events.indexOf(steps[refused - 1]) < at("afterTest"), trace);
  assert.ok(at("sent takeScreenshot") < events.indexOf(steps[refused]), trace);
  const step = steps[refused].slice("refused ".length);
  assert.match(
    failures.get("between short requests times out") ?? "",
    new RegExp(
      `^Timeout of 300ms exceeded\\..*\\nIts code was still running after its result \\(#170\\): the run refused 1 request \\(${step}\\)\\. The run refuses its later requests\\.$`,
      "s",
    ),
  );
  assert.ok(at("sent next") > at("sent cleanup"), trace);

  // The test that times out during a long request: Mocha goes on once that request has its
  // answer, and the code's next request is refused.
  assert.ok(at("answered long") < at("refused after long"), trace);
  assert.ok(at("refused after long") < at("sent cleanup after long"), trace);
  assert.match(
    failures.get("during a long request times out") ?? "",
    /\nIts code was still running after its result \(#170\): the run waited for the answers to 1 request \(long\), and refused 1 request \(after long\)\. The run refuses its later requests\.$/,
  );

  // Only the two tests that time out fail; code that goes on after its test passed is refused,
  // and the first refusal is printed to the log.
  assert.deepEqual(
    [...failures.keys()],
    ["between short requests times out", "during a long request times out"],
  );
  assert.deepEqual(passes, [
    "between short requests runs next",
    "after it passes leaves code running",
    "after it passes waits for that code",
  ]);
  assert.ok(at("refused late") < at("refused later"), trace);
  assert.deepEqual(logged, [
    '[late requests] Refused late from "after it passes leaves code running", which passed: its code was still running after its result (#170). The run refuses its later requests too.',
  ]);
});
