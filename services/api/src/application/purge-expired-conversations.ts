import type { Clock } from '../domain/ports/tracer.js';
import type { PurgeCounts, RetentionStore } from './ports/retention.js';

const MS_PER_DAY = 86_400_000;

/** Conversations deleted per transaction: bounds lock time and WAL per statement. */
export const PURGE_BATCH_SIZE = 500;

export interface PurgeExpiredConversationsDeps {
  readonly store: RetentionStore;
  readonly clock: Clock;
  /** Whole days of inactivity after which a conversation is deleted (at least 1). */
  readonly retentionDays: number;
  readonly batchSize?: number;
}

export interface PurgeResult extends PurgeCounts {
  readonly retentionDays: number;
  /** Conversations last active before this instant were (or would be) deleted. */
  readonly cutoff: Date;
  readonly dryRun: boolean;
  /** Delete statements issued (0 for a dry run). */
  readonly batches: number;
}

export interface PurgeExpiredConversations {
  execute(options?: { readonly dryRun?: boolean }): Promise<PurgeResult>;
}

/** `now` minus whole days: the start of the retention window. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

const NO_ROWS: PurgeCounts = { conversations: 0, messages: 0, runs: 0, feedback: 0 };

function add(left: PurgeCounts, right: PurgeCounts): PurgeCounts {
  return {
    conversations: left.conversations + right.conversations,
    messages: left.messages + right.messages,
    runs: left.runs + right.runs,
    feedback: left.feedback + right.feedback,
  };
}

/**
 * Retention (SECURITY.md): deletes the conversations inactive for more than `retentionDays`, with
 * their messages, runs and feedback, in batches until none is left.
 *
 * The daily cost cap sums today's runs (UTC), so the purge must never delete one of them. Two
 * rules guarantee it: the cutoff is at least one whole day back (validated below), hence before
 * the start of the current UTC day, and a conversation with any run recorded after the cutoff is
 * kept, whatever its `updated_at`. SendMessage also marks a conversation active before its run
 * starts, so a run in progress cannot lose its conversation (and its spend) to the purge.
 */
export function createPurgeExpiredConversations(
  deps: PurgeExpiredConversationsDeps,
): PurgeExpiredConversations {
  const { store, clock, retentionDays } = deps;
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError(
      `retentionDays must be a whole number of days >= 1 (got ${retentionDays})`,
    );
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer (got ${batchSize})`);
  }

  return {
    async execute({ dryRun = false } = {}) {
      const cutoff = retentionCutoff(clock.now(), retentionDays);
      const result = { retentionDays, cutoff, dryRun };
      if (dryRun) return { ...result, ...(await store.countExpired(cutoff)), batches: 0 };

      let total = NO_ROWS;
      let batches = 0;
      for (;;) {
        const deleted = await store.deleteExpired(cutoff, batchSize);
        total = add(total, deleted);
        batches += 1;
        // A short batch means nothing deletable is left (locked rows wait for the next purge).
        if (deleted.conversations < batchSize) break;
      }
      return { ...result, ...total, batches };
    },
  };
}
