/**
 * Keeps the code of a test or hook from driving Obsidian once it has its result (#170).
 *
 * WebdriverIO fails a test that runs past its timeout, but it cannot stop the test's code, which
 * goes on sending WebDriver requests while the next tests run, and can change what they see. Here
 * each test's and hook's code runs in a scope of its own, which everything that it starts
 * inherits: its promises, timers, and WebDriver commands. Once the test or hook has its result,
 * the run refuses the requests of that scope, and Mocha goes on only once the requests that it had
 * sent before have their answers. A failure's message tells what its code was still doing; the
 * first request refused after the result has been reported is printed to the log.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import Mocha from "mocha";

/**
 * How long Mocha waits for the answers to the requests that a test or hook sent before its result.
 * A script that a request runs can take as long as WebDriver's default script timeout, 30 s.
 */
const ANSWER_LIMIT_MS = 30_000;

/** A test or hook that runs or has run, and its WebDriver requests. */
interface Scope {
  readonly runnable: Mocha.Runnable;
  /** Set once the test or hook has its result, with the error of a failure. */
  result?: { error: unknown };
  /** Set once Mocha's runner has the result, and reports it. */
  reported: boolean;
  /** The commands of its requests that have no answer yet. */
  readonly unanswered: string[];
  /** The commands of its requests that were refused. */
  readonly refused: string[];
  /** Set once a refusal after the report has been printed to the log. */
  logged: boolean;
  /** Called on each answer while Mocha waits for the unanswered ones. */
  onAnswer?: () => void;
}

/** The scope of the code that runs; none for Mocha's runner and WebdriverIO's session hooks. */
const scopes = new AsyncLocalStorage<Scope | undefined>();

function scopeOf(runnable: Mocha.Runnable): Scope {
  return { runnable, reported: false, unanswered: [], refused: [], logged: false };
}

/** Set when a test runs outside its scope, which makes every request fail. */
let inactive: Error | undefined;

let scoped = false;

/** Runs the code of each test and hook in its own scope, from before Mocha runs. */
export function scopeRunnables(): void {
  if (scoped) return;
  scoped = true;
  const { run } = Mocha.Runnable.prototype;
  Mocha.Runnable.prototype.run = function (this: Mocha.Runnable, done: Mocha.Done): void {
    const scope = scopeOf(this);
    scopes.run(scope, () => {
      run.call(this, (error?: unknown) => {
        scope.result = { error };
        // Mocha's runner, which goes on to the next hook or test, runs in no scope.
        const report = () => {
          scope.reported = true;
          scopes.run(undefined, () => done(error));
        };
        if (scope.unanswered.length === 0) {
          if (scope.refused.length > 0) describeLateCode(scope, [], true);
          return report();
        }
        const waited = [...scope.unanswered];
        void answers(scope).then((answered) => {
          try {
            describeLateCode(scope, waited, answered);
          } finally {
            report();
          }
        });
      });
    });
  };
}

/**
 * Ends the code of the test that runs, from WebdriverIO's `afterTest` hook, and runs `work` in a
 * scope of its own. WebdriverIO fails a test that times out, runs its `afterTest` hooks, and only
 * then gives Mocha the result: without this, the test's code would go on driving Obsidian while
 * they run. It ends with the first of those hooks, which is the configuration's, so that a
 * service's own `afterTest` requests are refused too.
 */
export function endTestCode<T>(error: unknown, work: () => T): T {
  const scope = scopes.getStore();
  if (scope === undefined) return work();
  scope.result ??= { error };
  return scopes.run(scopeOf(scope.runnable), work);
}

/**
 * Whether the scope's requests have their answers, within ANSWER_LIMIT_MS. It then waits one turn
 * of the event loop, in which code that waited for an answer sends its next request, refused.
 */
function answers(scope: Scope): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (answered: boolean) => {
      clearTimeout(timer);
      scope.onAnswer = undefined;
      setImmediate(resolve, answered);
    };
    const timer = setTimeout(finish, ANSWER_LIMIT_MS, false);
    scope.onAnswer = () => {
      if (scope.unanswered.length === 0) finish(true);
    };
  });
}

function title(scope: Scope): string {
  const outcome = scope.runnable.isPending()
    ? "was skipped"
    : scope.result?.error === undefined
      ? "passed"
      : "failed";
  return `"${scope.runnable.fullTitle()}", which ${outcome}`;
}

function commands(names: readonly string[]): string {
  return `${names.length} request${names.length === 1 ? "" : "s"} (${names.join(", ")})`;
}

/** Adds what a test's or hook's code still did after its result to the failure that Mocha reports. */
function describeLateCode(scope: Scope, waited: readonly string[], answered: boolean): void {
  const parts: string[] = [];
  if (waited.length > 0) {
    const late = answered ? "" : `, which had none after ${ANSWER_LIMIT_MS / 1000} s`;
    parts.push(`waited for the answers to ${commands(waited)}${late}`);
  }
  if (scope.refused.length > 0) parts.push(`refused ${commands(scope.refused)}`);
  const note = `Its code was still running after its result (#170): the run ${parts.join(", and ")}. The run refuses its later requests.`;
  const { error } = scope.result!;
  if (error instanceof Error) {
    // V8 writes out a stack when it is first read, with the message at that time.
    const { message, stack } = error;
    error.message = `${message}\n${note}`;
    if (typeof stack === "string") error.stack = stack.replace(message, () => error.message);
  } else {
    console.error(`[late requests] ${title(scope)}: ${note}`);
  }
}

/** Records each WebDriver request of the browser's session in the scope that sends it. */
export function watchRequests(browser: WebdriverIO.Browser): void {
  browser.on("command", ({ command }) => {
    scopes.getStore()?.unanswered.push(command);
  });
  browser.on("result", ({ command }) => {
    const scope = scopes.getStore();
    if (scope === undefined) return;
    const index = scope.unanswered.lastIndexOf(command);
    if (index >= 0) scope.unanswered.splice(index, 1);
    scope.onAnswer?.();
  });
}

/**
 * Refuses a WebDriver request from a test or hook that has its result. WebdriverIO calls the
 * configuration's `transformRequest` for each request, in the scope that sends it, and a throw
 * there fails the command without sending it.
 */
export function refuseLateRequest(): void {
  if (inactive !== undefined) throw inactive;
  const scope = scopes.getStore();
  if (scope?.result === undefined) return;
  // The browser's "command" event for this request came just before.
  const command = scope.unanswered.at(-1) ?? "a request";
  scope.refused.push(command);
  const message = `Refused ${command} from ${title(scope)}: its code was still running after its result (#170).`;
  // A refusal before the report is in the failure's message.
  if (scope.reported && !scope.logged) {
    scope.logged = true;
    console.error(`[late requests] ${message} The run refuses its later requests too.`);
  }
  throw new Error(message);
}

/**
 * Makes every request fail if a test runs outside its own scope, in which the run could not tell
 * its late requests from the next test's.
 */
export function checkScope(test: Mocha.Runnable | undefined): void {
  if (scopes.getStore()?.runnable === test) return;
  inactive ??= new Error(
    "A test runs outside its scope, so the run cannot refuse the requests of a test that has its result (#170): support/late-requests.ts has not wrapped Runnable#run of the Mocha that runs the tests.",
  );
}
