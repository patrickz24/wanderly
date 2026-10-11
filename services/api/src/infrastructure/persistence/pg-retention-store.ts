import type { PurgeCounts, RetentionStore } from '../../application/ports/retention.js';
import type { SqlExecutor } from './database.js';

interface CountsRow {
  conversations: number;
  messages: number;
  runs: number;
  feedback: number;
}

/**
 * Expired conversations (see `RetentionStore`). The `NOT EXISTS` clause keeps any conversation
 * with a run recorded after the cutoff: the daily cost cap sums `agent_runs`, and a failed run
 * does not move `updated_at`. Served by `conversations_updated_at_idx` and
 * `agent_runs_conversation_id_created_at_idx`.
 */
const EXPIRED = `
  SELECT c.id
  FROM conversations c
  WHERE c.updated_at < $1
    AND NOT EXISTS (
      SELECT 1 FROM agent_runs r WHERE r.conversation_id = c.id AND r.created_at >= $1
    )`;

/** Row counts of the conversations in the `expired` CTE (seen before the delete). */
const COUNTS = `
  (SELECT count(*) FROM messages m WHERE m.conversation_id IN (SELECT id FROM expired))::int
    AS messages,
  (SELECT count(*) FROM agent_runs r WHERE r.conversation_id IN (SELECT id FROM expired))::int
    AS runs,
  (SELECT count(*) FROM feedback f JOIN agent_runs r ON r.id = f.run_id
   WHERE r.conversation_id IN (SELECT id FROM expired))::int AS feedback`;

const toCounts = (row: CountsRow | undefined): PurgeCounts => ({
  conversations: row?.conversations ?? 0,
  messages: row?.messages ?? 0,
  runs: row?.runs ?? 0,
  feedback: row?.feedback ?? 0,
});

/** Retention purge over Postgres; deleting a conversation cascades to everything it owns. */
export class PgRetentionStore implements RetentionStore {
  constructor(private readonly db: SqlExecutor) {}

  async deleteExpired(cutoff: Date, limit: number): Promise<PurgeCounts> {
    // One statement, so one transaction. Every part of it sees the same snapshot, so the counts
    // describe the rows as they were just before the delete. `SKIP LOCKED` leaves a conversation
    // that a request is writing to for the next purge instead of blocking that request; if the
    // writer moved `updated_at`, the row is re-checked and no longer matches.
    const { rows } = await this.db.query<CountsRow>(
      `WITH expired AS MATERIALIZED (
         ${EXPIRED}
         ORDER BY c.updated_at, c.id
         LIMIT $2
         FOR UPDATE OF c SKIP LOCKED
       ),
       deleted AS (
         DELETE FROM conversations c USING expired e WHERE c.id = e.id RETURNING c.id
       )
       SELECT (SELECT count(*) FROM deleted)::int AS conversations, ${COUNTS}`,
      [cutoff, limit],
    );
    return toCounts(rows[0]);
  }

  async countExpired(cutoff: Date): Promise<PurgeCounts> {
    const { rows } = await this.db.query<CountsRow>(
      `WITH expired AS MATERIALIZED (${EXPIRED})
       SELECT (SELECT count(*) FROM expired)::int AS conversations, ${COUNTS}`,
      [cutoff],
    );
    return toCounts(rows[0]);
  }
}
