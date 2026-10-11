/** Rows removed (or that would be removed) by the retention purge. */
export interface PurgeCounts {
  readonly conversations: number;
  readonly messages: number;
  readonly runs: number;
  readonly feedback: number;
}

/**
 * Deletion of expired conversations. A conversation is expired when it was last updated before
 * `cutoff` AND none of its runs was recorded at or after `cutoff`: a failed run does not update
 * its conversation, and the runs are the daily cost cap's ledger, so a recent run always keeps
 * its conversation.
 */
export interface RetentionStore {
  /**
   * Deletes at most `limit` expired conversations, oldest first, with their messages, runs and
   * feedback (cascade). Conversations locked by a concurrent writer are skipped, not waited for.
   */
  deleteExpired(cutoff: Date, limit: number): Promise<PurgeCounts>;
  /** What `deleteExpired` would remove with no limit, without deleting anything. */
  countExpired(cutoff: Date): Promise<PurgeCounts>;
}
