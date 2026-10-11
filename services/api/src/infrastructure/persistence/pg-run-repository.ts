import type {
  Feedback,
  FeedbackRepository,
  RunRecord,
  RunRepository,
  SpendLedger,
  VisibleRun,
} from '../../application/ports/runs.js';
import type { Database } from './database.js';

/** Agent runs over Postgres: accounting, observability fields and display payload. */
export class PgRunRepository implements RunRepository {
  constructor(private readonly db: Database) {}

  async save(run: RunRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_runs (
         id, conversation_id, trace_id, model, status, response_type, error_code, failure_reason,
         steps, repairs, tool_calls, tool_errors,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms,
         schema_valid_first_try, citations_ok,
         user_text, user_message_id, assistant_message_id, response, sources, tool_call_log,
         created_at, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)`,
      [
        run.id,
        run.conversationId,
        run.traceId,
        run.model,
        run.status,
        run.responseType,
        run.errorCode,
        run.failureReason,
        run.steps,
        run.repairs,
        run.toolCallCount,
        run.toolErrorCount,
        run.usage.inputTokens,
        run.usage.outputTokens,
        run.usage.cacheReadTokens,
        run.usage.cacheWriteTokens,
        run.costUsd,
        Math.round(run.latencyMs),
        run.validFirstTry,
        run.citationsOk,
        run.userText,
        run.userMessageId,
        run.assistantMessageId,
        run.response === null ? null : JSON.stringify(run.response),
        JSON.stringify(run.sources),
        JSON.stringify(run.toolCalls),
        run.createdAt,
        run.promptVersion,
      ],
    );
  }

  async findForSession(runId: string, sessionId: string): Promise<VisibleRun | null> {
    const { rows } = await this.db.query<{ id: string; trace_id: string | null }>(
      `SELECT r.id, r.trace_id
       FROM agent_runs r
       JOIN conversations c ON c.id = r.conversation_id
       WHERE r.id = $1 AND c.session_id = $2`,
      [runId, sessionId],
    );
    const [row] = rows;
    return row === undefined ? null : { id: row.id, traceId: row.trace_id };
  }
}

/** Today's spend, summed from `agent_runs` (the index on created_at includes cost_usd). */
export class PgSpendLedger implements SpendLedger {
  constructor(private readonly db: Database) {}

  async spentUsd(from: Date, to: Date): Promise<number> {
    const { rows } = await this.db.query<{ spent: number }>(
      `SELECT COALESCE(sum(cost_usd), 0)::float8 AS spent
       FROM agent_runs
       WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    return rows[0]?.spent ?? 0;
  }
}

export class PgFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: Database) {}

  async upsert(feedback: Feedback): Promise<void> {
    await this.db.query(
      `INSERT INTO feedback (run_id, rating, comment, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = EXCLUDED.created_at`,
      [feedback.runId, feedback.rating, feedback.comment, feedback.createdAt],
    );
  }
}
