/**
 * Bounded shutdown primitives: a host stop must finish even when a subsystem does not.
 *
 * Every step runs against a deadline, an overrun is abandoned and named in the log, and
 * no caller ever awaits a promise that can keep the process alive forever. The emitted
 * lines are the permanent shutdown telemetry: `logs/ranite.log` records which step
 * completed, which one was abandoned and how long each took, so a stalled shutdown names
 * its own culprit instead of surfacing as a force-kill thirty seconds later.
 */

export type ShutdownLog = (message: string) => void;

export interface ShutdownStepOptions {
  /** Spend reserved time on this step even after the shared budget ran out (durable work). */
  reserve?: boolean;
}

function defaultDescribe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export class ShutdownBudget {
  private readonly deadline: number;

  constructor(
    totalMs: number,
    private readonly log: ShutdownLog,
    private readonly reserveMs = 0,
    private readonly describe: (error: unknown) => string = defaultDescribe,
  ) {
    this.deadline = Date.now() + totalMs;
  }

  /** Milliseconds left of the shared budget. */
  get remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  /**
   * Runs one shutdown step under `stepMs`, further capped by what is left of the shared
   * budget, and never rejects: a step that overruns, fails or gets skipped returns false
   * so shutdown keeps moving. The abandoned operation is left to settle on its own and
   * its later rejection is swallowed, because the process is going away either way.
   */
  async run(name: string, stepMs: number, operation: () => unknown, options: ShutdownStepOptions = {}): Promise<boolean> {
    const available = options.reserve === true ? this.remainingMs + this.reserveMs : this.remainingMs;
    const budget = Math.min(stepMs, available);
    if (budget <= 0) {
      this.log(`[shutdown] ${name}: skipped, shutdown budget exhausted`);
      return false;
    }
    const startedAt = Date.now();
    let failed = false;
    let failure: unknown;
    const completion = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        failed = true;
        failure = error;
      })
      .then(() => 'settled' as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([completion, timeout]);
      const tookMs = Date.now() - startedAt;
      if (outcome === 'timeout') {
        this.log(`[shutdown] ${name}: abandoned after ${tookMs}ms (budget ${budget}ms)`);
        return false;
      }
      if (failed) {
        this.log(`[shutdown] ${name}: failed after ${tookMs}ms — ${this.describe(failure)}`);
        return false;
      }
      this.log(`[shutdown] ${name}: done in ${tookMs}ms`);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Runs `operation` but gives up after `timeoutMs`, so a deferred load or a serialized
 * chain can never hold a caller for ever. The abandoned operation keeps running and its
 * eventual outcome is swallowed so it cannot become an unhandled rejection.
 */
export function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = operation().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const timeout = new Promise<{ ok: false; error: Error }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: new Error(`${label} did not finish within ${timeoutMs} ms.`) }), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([pending, timeout]).then((result) => {
    clearTimeout(timer);
    if (result.ok) return result.value;
    throw result.error;
  });
}
