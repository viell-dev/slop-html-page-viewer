// Long work in slices, between which the window handles input, runs timers,
// and draws. Obsidian and its plugins share one thread, so work that never
// gives the window a turn keeps all of Obsidian from responding (#158).

/**
 * Work in steps: it yields now and then, with how much it has done since, in
 * units of about a microsecond at most.
 */
export type Steps<T> = Generator<number, T, void>;

/** Does work in steps to its end at once. */
export function finish<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

/**
 * How long a slice runs before the window gets a turn, in milliseconds: less
 * than a reader notices, and long enough that turns cost next to nothing. Work
 * between steps that is not in steps itself makes a slice longer, as following
 * the rules of a stylesheet of millions of characters does.
 */
const SLICE = 25;

/**
 * How much work runs between looks at the clock. Ordinary pages take less in
 * all, so that preparing them is one slice, whose end depends on no turn.
 */
const LOOK = 4096;

/** The work that was going on is no longer wanted. */
export class StoppedError extends Error {
  override readonly name = "StoppedError";
}

/** The turns that one piece of long work gives the window. */
export class Turns {
  private done = 0;
  private start = performance.now();

  /** Work whose result is no longer wanted, as `stopped` says after a turn, ends with a `StoppedError`. */
  constructor(private readonly stopped: () => boolean = () => false) {}

  /** Counts this much more work, and says whether the window is due a turn (`give`). */
  due(work: number): boolean {
    this.done += work;
    if (this.done < LOOK) return false;
    this.done = 0;
    return performance.now() - this.start >= SLICE;
  }

  /**
   * Gives the window a turn. A message comes in a task of its own, as a timer
   * does, but Chromium delays timers in windows that it does not draw, and
   * ones that follow each other.
   */
  async give(): Promise<void> {
    await new Promise<void>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        port1.close();
        resolve();
      };
      port2.postMessage(null);
    });
    if (this.stopped()) throw new StoppedError();
    this.start = performance.now();
  }

  /**
   * Counts this much more work, and gives the window a turn if it is due one.
   * Work that is no longer wanted ends here, also without a turn, as where it
   * has waited for a file.
   */
  async step(work: number): Promise<void> {
    if (this.stopped()) throw new StoppedError();
    if (this.due(work)) await this.give();
  }

  /** Does work in steps, giving the window a turn whenever it is due one. */
  async run<T>(steps: Steps<T>): Promise<T> {
    for (;;) {
      const step = steps.next();
      if (step.done === true) return step.value;
      if (this.due(step.value)) await this.give();
    }
  }
}
