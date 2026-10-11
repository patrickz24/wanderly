import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PurgeExpiredConversations,
  PurgeResult,
} from '../application/purge-expired-conversations.js';
import { PURGE_INTERVAL_MS, purgeLogFields, startRetentionSchedule } from './retention-schedule.js';

const RESULT: PurgeResult = {
  retentionDays: 30,
  cutoff: new Date('2026-09-11T10:00:00.000Z'),
  dryRun: false,
  conversations: 3,
  messages: 40,
  runs: 6,
  feedback: 1,
  batches: 1,
};

function fakeLog() {
  return { info: vi.fn(), error: vi.fn() };
}

function purgeReturning(...outcomes: Array<PurgeResult | Error>): PurgeExpiredConversations & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async () => {
    const outcome = outcomes.shift() ?? RESULT;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { execute };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startRetentionSchedule', () => {
  it('purges at startup, then every 24 hours, and logs the counts', async () => {
    const purge = purgeReturning();
    const log = fakeLog();
    let clock = 1_000;

    const schedule = startRetentionSchedule({ purge, log, now: () => (clock += 25) });
    await vi.advanceTimersByTimeAsync(0);

    expect(purge.execute).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      {
        retentionDays: 30,
        cutoff: '2026-09-11T10:00:00.000Z',
        conversations: 3,
        messages: 40,
        runs: 6,
        feedback: 1,
        batches: 1,
        durationMs: 25,
      },
      'retention purge completed',
    );

    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS - 1);
    expect(purge.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(purge.execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS);
    expect(purge.execute).toHaveBeenCalledTimes(3);

    await schedule.stop();
  });

  it('logs a failure and tries again at the next tick, without throwing', async () => {
    const failure = new Error('connection refused');
    const purge = purgeReturning(failure);
    const log = fakeLog();

    const schedule = startRetentionSchedule({ purge, log, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).toHaveBeenCalledExactlyOnceWith({ err: failure }, 'retention purge failed');
    expect(log.info).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(purge.execute).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledTimes(1);

    await schedule.stop();
  });

  it('skips a tick while the previous purge is still running', async () => {
    let finish: (result: PurgeResult) => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<PurgeResult>((resolve) => {
          finish = resolve;
        }),
    );
    const schedule = startRetentionSchedule({
      purge: { execute },
      log: fakeLog(),
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(execute).toHaveBeenCalledTimes(1);

    finish(RESULT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(2);

    finish(RESULT);
    await schedule.stop();
  });

  it('stops the timer and waits for the purge in progress', async () => {
    let finish: (result: PurgeResult) => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<PurgeResult>((resolve) => {
          finish = resolve;
        }),
    );
    const log = fakeLog();
    const schedule = startRetentionSchedule({ purge: { execute }, log, intervalMs: 1_000 });

    let stopped = false;
    const stopping = schedule.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish(RESULT);
    await stopping;
    expect(log.info).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('purgeLogFields', () => {
  it('reports counts and the cutoff only', () => {
    expect(Object.keys(purgeLogFields(RESULT, 12))).toEqual([
      'retentionDays',
      'cutoff',
      'conversations',
      'messages',
      'runs',
      'feedback',
      'batches',
      'durationMs',
    ]);
  });
});
