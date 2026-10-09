import type {
  CheckOutcome,
  CheckResult,
  ReadinessCheck,
  ReadinessProbe,
  ReadinessReport,
} from './ports/readiness.js';

export interface ReadinessProbeOptions {
  /** Per-check deadline. A probe must answer fast, even when a dependency hangs. */
  readonly timeoutMs?: number;
  /** Monotonic clock in milliseconds (injected for tests). */
  readonly now?: () => number;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/**
 * Builds a readiness probe that runs every check concurrently, each with its own
 * timeout. A check that throws or times out fails without failing the others.
 */
export function createReadinessProbe(
  checks: readonly ReadinessCheck[],
  options: ReadinessProbeOptions = {},
): ReadinessProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());

  if (checks.length === 0) {
    throw new Error('A readiness probe needs at least one check');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Readiness check timeout must be a positive number of milliseconds');
  }
  const names = checks.map((check) => check.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new Error(`Duplicate readiness check name: ${duplicate}`);
  }

  return {
    async check(): Promise<ReadinessReport> {
      const results = await Promise.all(
        checks.map(async (check) => [check.name, await runCheck(check, timeoutMs, now)] as const),
      );
      return summarize(results);
    },
  };
}

function summarize(results: ReadonlyArray<readonly [string, CheckResult]>): ReadinessReport {
  const allPass = results.every(([, result]) => result.status === 'pass');
  return {
    status: allPass ? 'pass' : 'fail',
    checks: Object.fromEntries(results),
  };
}

async function runCheck(
  check: ReadinessCheck,
  timeoutMs: number,
  now: () => number,
): Promise<CheckResult> {
  const startedAt = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'fail', output: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });

  let outcome: CheckOutcome;
  try {
    outcome = await Promise.race([check.run(controller.signal), timeout]);
  } catch (error) {
    outcome = { status: 'fail', output: 'check failed', detail: error };
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Math.max(0, Math.round(now() - startedAt));
  return outcome.status === 'pass'
    ? { status: 'pass', durationMs }
    : { status: 'fail', durationMs, output: outcome.output, detail: outcome.detail };
}
