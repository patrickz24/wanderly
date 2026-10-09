import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckOutcome, ReadinessCheck } from './ports/readiness.js';
import { DEFAULT_CHECK_TIMEOUT_MS, createReadinessProbe } from './readiness.js';

const check = (
  name: string,
  run: (signal: AbortSignal) => Promise<CheckOutcome>,
): ReadinessCheck => ({ name, run });

const passing = (name: string) => check(name, async () => ({ status: 'pass' }));

/** A clock that advances by `step` ms each time it is read. */
const steppingClock = (step: number) => {
  let current = 0;
  return () => {
    const value = current;
    current += step;
    return value;
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createReadinessProbe', () => {
  it('passes when every check passes', async () => {
    const probe = createReadinessProbe([passing('database'), passing('migrations')]);

    const report = await probe.check();

    expect(report.status).toBe('pass');
    expect(Object.keys(report.checks)).toEqual(['database', 'migrations']);
    expect(report.checks['migrations']?.status).toBe('pass');
  });

  it('measures each check with the injected clock', async () => {
    const probe = createReadinessProbe([passing('database')], { now: steppingClock(5) });

    const report = await probe.check();

    expect(report.checks['database']).toEqual({ status: 'pass', durationMs: 5 });
  });

  it('fails overall when one check fails, keeping the others', async () => {
    const probe = createReadinessProbe([
      passing('database'),
      check('migrations', async () => ({
        status: 'fail',
        output: '1 pending migration(s)',
        detail: { pending: ['002_x'] },
      })),
    ]);

    const report = await probe.check();

    expect(report.status).toBe('fail');
    expect(report.checks['database']?.status).toBe('pass');
    expect(report.checks['migrations']).toMatchObject({
      status: 'fail',
      output: '1 pending migration(s)',
      detail: { pending: ['002_x'] },
    });
  });

  it('turns a thrown error into a generic failure and keeps the error as detail', async () => {
    const boom = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const probe = createReadinessProbe([
      check('database', async () => {
        throw boom;
      }),
    ]);

    const report = await probe.check();

    expect(report.checks['database']).toMatchObject({ status: 'fail', output: 'check failed' });
    expect(report.checks['database']?.detail).toBe(boom);
  });

  it('handles checks that throw synchronously', async () => {
    const probe = createReadinessProbe([
      {
        name: 'sync',
        run: () => {
          throw new Error('not even a promise');
        },
      },
    ]);

    await expect(probe.check()).resolves.toMatchObject({ status: 'fail' });
  });

  it('times out a hanging check, aborts its signal and does not block the others', async () => {
    vi.useFakeTimers();
    let received: AbortSignal | undefined;
    const probe = createReadinessProbe(
      [
        passing('database'),
        check('embedder', (signal) => {
          received = signal;
          return new Promise<CheckOutcome>(() => undefined);
        }),
      ],
      { timeoutMs: 1_000 },
    );

    const pending = probe.check();
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await pending;

    expect(report.status).toBe('fail');
    expect(report.checks['database']?.status).toBe('pass');
    expect(report.checks['embedder']).toMatchObject({
      status: 'fail',
      output: 'timed out after 1000 ms',
    });
    expect(received?.aborted).toBe(true);
  });

  it('clears the timer when a check settles in time', async () => {
    vi.useFakeTimers();
    const probe = createReadinessProbe([passing('database')]);

    await probe.check();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a 2 second default timeout', () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(2_000);
  });

  it('never reports a negative duration', async () => {
    let calls = 0;
    const backwardsClock = () => (calls++ === 0 ? 10 : 4);
    const probe = createReadinessProbe([passing('database')], { now: backwardsClock });

    const report = await probe.check();

    expect(report.checks['database']?.durationMs).toBe(0);
  });

  it.each([
    ['no checks', [], {}, 'at least one check'],
    ['duplicate names', [passing('db'), passing('db')], {}, 'Duplicate readiness check name: db'],
    ['zero timeout', [passing('db')], { timeoutMs: 0 }, 'positive number'],
    ['NaN timeout', [passing('db')], { timeoutMs: Number.NaN }, 'positive number'],
  ])('rejects invalid configuration: %s', (_label, checks, options, message) => {
    expect(() => createReadinessProbe(checks, options)).toThrow(message);
  });
});
