/**
 * The configuration's WebdriverIO hooks for its tests and requests, which late-requests.check.ts
 * runs as they are. They refuse the requests of a test or hook that has its result (#170), and keep
 * a screenshot of Obsidian's window for each failed test (#77). This module has no side effects, so
 * that the check can import it without the configuration, which downloads hosts and clears results.
 */
import path from "node:path";
import {
  checkScope,
  endTestCode,
  refuseLateRequest,
  watchRequests,
  type RequestEvents,
} from "./late-requests.ts";

/** What the hooks use of WebdriverIO's browser. */
export interface Session extends RequestEvents {
  getObsidianVersion(): string;
  saveScreenshot(file: string): Promise<unknown>;
}

/** The hooks for `browser`, which save screenshots in the `screenshots` folder. */
export function testHooks(browser: Session, screenshots: string) {
  return {
    /**
     * Refuses each request from a test or hook that has its result. It replaces
     * wdio-obsidian-service's own transformRequest, which the service sets in beforeSession only
     * when the configuration has none. In 3.5.0 that one removes the Connection and Content-Length
     * headers, which WebdriverIO 10 never sets (webdriverio/webdriverio#15265, closed); recheck it
     * when the service changes.
     */
    transformRequest<Options>(requestOptions: Options): Options {
      refuseLateRequest();
      return requestOptions;
    },
    before(): void {
      watchRequests(browser);
    },
    beforeTest(_test: unknown, context: Mocha.Context): void {
      checkScope(context.test);
    },
    /**
     * Ends the test's code at once, before anything else, and then takes the failed test's
     * screenshot in a scope of its own. WebdriverIO fails a test that times out and runs its
     * afterTest hooks, the configuration's first, before Mocha has the result.
     */
    afterTest(
      test: { parent: string; title: string },
      _context: unknown,
      { error, passed }: { error?: unknown; passed: boolean },
    ): Promise<void> {
      return endTestCode(error, async () => {
        if (passed) return;
        const name = `${test.parent} ${test.title}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 100);
        const file = `failed-${browser.getObsidianVersion()}-${name}.png`;
        await browser.saveScreenshot(path.join(screenshots, file)).catch(() => undefined);
      });
    },
  };
}
