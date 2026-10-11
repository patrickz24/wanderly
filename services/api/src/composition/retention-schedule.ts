import type {
  PurgeExpiredConversations,
  PurgeResult,
} from '../application/purge-expired-conversations.js';

/** The purge runs at startup, then once a day. */
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RetentionScheduleLogger {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface RetentionScheduleOptions {
  readonly purge: PurgeExpiredConversations;
  readonly log: RetentionScheduleLogger;
  readonly intervalMs?: number;
  /** Milliseconds since an arbitrary origin, to time each purge. */
  readonly now?: () => number;
}

export interface RetentionSchedule {
  /** Stops the timer and waits for a purge in progress, so the pool can be closed after it. */
  stop(): Promise<void>;
}

/** The log fields of a purge: counts and cutoff, never conversation content. */
export function purgeLogFields(result: PurgeResult, durationMs: number): Record<string, unknown> {
  return {
    retentionDays: result.retentionDays,
    cutoff: result.cutoff.toISOString(),
    conversations: result.conversations,
    messages: result.messages,
    runs: result.runs,
    feedback: result.feedback,
    batches: result.batches,
    durationMs,
  };
}

/**
 * Runs the retention purge now and then every `intervalMs`, in the background. A failure is logged
 * and never thrown: the next tick tries again. A tick that finds the previous purge still running
 * is skipped. The timer does not keep the process alive.
 */
export function startRetentionSchedule(options: RetentionScheduleOptions): RetentionSchedule {
  const { purge, log } = options;
  const now = options.now ?? (() => performance.now());
  let running: Promise<void> | undefined;
  let stopped = false;

  const purgeOnce = async (): Promise<void> => {
    const startedAt = now();
    try {
      const result = await purge.execute();
      log.info(purgeLogFields(result, Math.round(now() - startedAt)), 'retention purge completed');
    } catch (error) {
      log.error({ err: error }, 'retention purge failed');
    }
  };

  const tick = (): void => {
    if (stopped || running !== undefined) return;
    running = purgeOnce().finally(() => {
      running = undefined;
    });
  };

  const timer = setInterval(tick, options.intervalMs ?? PURGE_INTERVAL_MS);
  timer.unref();
  tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
