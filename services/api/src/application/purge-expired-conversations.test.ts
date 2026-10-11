import { describe, expect, it, vi } from 'vitest';
import { manualClock } from '../../test/application-fakes.js';
import type { PurgeCounts, RetentionStore } from './ports/retention.js';
import {
  PURGE_BATCH_SIZE,
  createPurgeExpiredConversations,
  retentionCutoff,
} from './purge-expired-conversations.js';
import { utcDayBounds } from './run-accounting.js';

const counts = (conversations: number, messages = 0, runs = 0, feedback = 0): PurgeCounts => ({
  conversations,
  messages,
  runs,
  feedback,
});

/** A store that returns the scripted batches in order, then empty batches. */
function scriptedStore(batches: PurgeCounts[], wouldDelete = counts(0)) {
  const remaining = [...batches];
  return {
    deleteExpired: vi.fn<RetentionStore['deleteExpired']>(
      async () => remaining.shift() ?? counts(0),
    ),
    countExpired: vi.fn<RetentionStore['countExpired']>(async () => wouldDelete),
  };
}

describe('retentionCutoff', () => {
  it('goes back whole days from now', () => {
    expect(retentionCutoff(new Date('2026-10-11T10:30:00.000Z'), 30)).toEqual(
      new Date('2026-09-11T10:30:00.000Z'),
    );
  });

  it.each(['2026-10-11T00:00:00.000Z', '2026-10-11T12:00:00.000Z', '2026-10-11T23:59:59.999Z'])(
    'falls before the current UTC day even with one day of retention (now %s)',
    (iso) => {
      const now = new Date(iso);
      expect(retentionCutoff(now, 1).getTime()).toBeLessThan(utcDayBounds(now).from.getTime());
    },
  );
});

describe('PurgeExpiredConversations', () => {
  it('deletes with the cutoff of the retention window and sums what the store removed', async () => {
    const store = scriptedStore([counts(3, 40, 6, 1)]);
    const purge = createPurgeExpiredConversations({
      store,
      clock: manualClock('2026-10-11T10:00:00.000Z'),
      retentionDays: 30,
    });

    const result = await purge.execute();

    expect(store.deleteExpired).toHaveBeenCalledExactlyOnceWith(
      new Date('2026-09-11T10:00:00.000Z'),
      PURGE_BATCH_SIZE,
    );
    expect(store.countExpired).not.toHaveBeenCalled();
    expect(result).toEqual({
      retentionDays: 30,
      cutoff: new Date('2026-09-11T10:00:00.000Z'),
      dryRun: false,
      conversations: 3,
      messages: 40,
      runs: 6,
      feedback: 1,
      batches: 1,
    });
  });

  it('keeps deleting full batches until a short one shows nothing is left', async () => {
    const store = scriptedStore([counts(2, 10, 4, 1), counts(2, 6, 2, 0), counts(1, 3, 1, 0)]);
    const purge = createPurgeExpiredConversations({
      store,
      clock: manualClock(),
      retentionDays: 30,
      batchSize: 2,
    });

    const result = await purge.execute();

    expect(store.deleteExpired).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      conversations: 5,
      messages: 19,
      runs: 7,
      feedback: 1,
      batches: 3,
    });
  });

  it('issues one statement when nothing is expired', async () => {
    const store = scriptedStore([]);
    const purge = createPurgeExpiredConversations({
      store,
      clock: manualClock(),
      retentionDays: 7,
    });

    const result = await purge.execute();

    expect(store.deleteExpired).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ conversations: 0, messages: 0, runs: 0, feedback: 0 });
  });

  it('only counts in a dry run', async () => {
    const store = scriptedStore([counts(9)], counts(4, 12, 5, 2));
    const purge = createPurgeExpiredConversations({
      store,
      clock: manualClock('2026-10-11T10:00:00.000Z'),
      retentionDays: 1,
    });

    const result = await purge.execute({ dryRun: true });

    expect(store.deleteExpired).not.toHaveBeenCalled();
    expect(store.countExpired).toHaveBeenCalledExactlyOnceWith(
      new Date('2026-10-10T10:00:00.000Z'),
    );
    expect(result).toEqual({
      retentionDays: 1,
      cutoff: new Date('2026-10-10T10:00:00.000Z'),
      dryRun: true,
      conversations: 4,
      messages: 12,
      runs: 5,
      feedback: 2,
      batches: 0,
    });
  });

  it('propagates a store failure (the caller logs it)', async () => {
    const store = scriptedStore([]);
    store.deleteExpired.mockRejectedValueOnce(new Error('connection refused'));
    const purge = createPurgeExpiredConversations({
      store,
      clock: manualClock(),
      retentionDays: 30,
    });

    await expect(purge.execute()).rejects.toThrow('connection refused');
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses a retention of %s days, which could reach into the current day',
    (retentionDays) => {
      expect(() =>
        createPurgeExpiredConversations({
          store: scriptedStore([]),
          clock: manualClock(),
          retentionDays,
        }),
      ).toThrow(RangeError);
    },
  );

  it('refuses an invalid batch size', () => {
    expect(() =>
      createPurgeExpiredConversations({
        store: scriptedStore([]),
        clock: manualClock(),
        retentionDays: 30,
        batchSize: 0,
      }),
    ).toThrow(RangeError);
  });
});
