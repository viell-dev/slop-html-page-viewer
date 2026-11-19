// The run itself: a test's code that goes on after the test's result, as a test's code does after
// a timeout, cannot drive Obsidian (support/late-requests.ts, #170). Its refusal is printed to the
// log on each run.
import { browser, expect } from "@wdio/globals";

describe("The test run in Obsidian", function () {
  let late: Promise<string> = Promise.resolve("never started");

  it("leaves code running after it passes", function () {
    const test = this.test!;
    late = (async () => {
      const end = Date.now() + 10_000;
      while (test.state === undefined && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (test.state === undefined) return "the test never ended";
      await browser.execute(() => {
        document.body.dataset.lateRequest = "sent";
      });
      return "sent";
    })().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  });

  it("refuses that code's WebDriver requests, which never reach Obsidian", async function () {
    expect(await late).toBe(
      'Refused executeScript from "The test run in Obsidian leaves code running after it passes", which passed: its code was still running after its result (#170).',
    );
    expect(await browser.execute(() => document.body.dataset.lateRequest ?? null)).toBeNull();
  });
});
