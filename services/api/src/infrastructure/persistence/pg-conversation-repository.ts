import type { TripBrief } from '@wanderly/contracts';
import type {
  Conversation,
  ConversationRepository,
  ConversationTurn,
  ConversationUpdate,
  NewMessage,
} from '../../application/ports/conversations.js';
import { NotFoundError } from '../../domain/errors.js';
import type { LlmMessage } from '../../domain/ports/llm.js';
import type { Database } from './database.js';
import {
  StoredDisplaySchema,
  parseStoredBrief,
  parseStoredMessage,
  storedRole,
} from './stored-values.js';

interface ConversationRow {
  id: string;
  session_id: string;
  title: string | null;
  trip_brief: unknown;
  created_at: Date;
  updated_at: Date;
}

interface TurnRow {
  run_id: string;
  user_message_id: string;
  user_text: string | null;
  user_created_at: Date;
  assistant_message_id: string | null;
  response: unknown;
  sources: unknown;
  tool_call_log: unknown;
  completed_at: Date;
  trace_id: string | null;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  rating: number | null;
}

const CONVERSATION_COLUMNS = 'id, session_id, title, trip_brief, created_at, updated_at';

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    brief: parseStoredBrief(row.trip_brief),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTurn(row: TurnRow): ConversationTurn {
  const display = StoredDisplaySchema.safeParse({
    response: row.response,
    sources: row.sources,
    toolCalls: row.tool_call_log,
  });
  if (!display.success) {
    throw new Error(`Run ${row.run_id} has an invalid stored display payload`, {
      cause: display.error,
    });
  }
  return {
    runId: row.run_id,
    userMessageId: row.user_message_id,
    userText: row.user_text ?? '',
    userCreatedAt: row.user_created_at,
    assistantMessageId: row.assistant_message_id ?? row.run_id,
    response: display.data.response,
    sources: display.data.sources,
    toolCalls: display.data.toolCalls,
    completedAt: row.completed_at,
    run: {
      steps: row.steps,
      usage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
      },
      costUsd: row.cost_usd,
      latencyMs: row.latency_ms ?? 0,
      traceId: row.trace_id,
    },
    feedbackRating: row.rating === 1 || row.rating === -1 ? row.rating : null,
  };
}

const json = (value: unknown): string => JSON.stringify(value);

/** Conversations and their append-only transcript, over Postgres. */
export class PgConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

  async create({
    id,
    sessionId,
    brief,
    now,
  }: {
    readonly id: string;
    readonly sessionId: string;
    readonly brief: TripBrief;
    readonly now: Date;
  }): Promise<Conversation> {
    const { rows } = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (id, session_id, title, trip_brief, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $4)
       RETURNING ${CONVERSATION_COLUMNS}`,
      [id, sessionId, json(brief), now],
    );
    return toConversation(firstRow(rows, 'INSERT conversations'));
  }

  async listForSession(sessionId: string, limit: number): Promise<readonly Conversation[]> {
    const { rows } = await this.db.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations
       WHERE session_id = $1
       ORDER BY updated_at DESC, id
       LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map(toConversation);
  }

  async findForSession(id: string, sessionId: string): Promise<Conversation | null> {
    const { rows } = await this.db.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1 AND session_id = $2`,
      [id, sessionId],
    );
    const [row] = rows;
    return row === undefined ? null : toConversation(row);
  }

  async listTurns(conversationId: string): Promise<readonly ConversationTurn[]> {
    const { rows } = await this.db.query<TurnRow>(
      `SELECT r.id AS run_id, r.user_message_id, r.user_text, um.created_at AS user_created_at,
              r.assistant_message_id, r.response, r.sources, r.tool_call_log,
              r.created_at AS completed_at, r.trace_id, r.steps, r.input_tokens, r.output_tokens,
              r.cache_read_tokens, r.cache_write_tokens, r.cost_usd::float8 AS cost_usd,
              r.latency_ms, f.rating
       FROM agent_runs r
       JOIN messages um ON um.id = r.user_message_id
       LEFT JOIN feedback f ON f.run_id = r.id
       WHERE r.conversation_id = $1 AND r.status = 'ok' AND r.response IS NOT NULL
       ORDER BY um.seq`,
      [conversationId],
    );
    return rows.map(toTurn);
  }

  async countCompletedTurns(conversationId: string): Promise<number> {
    const { rows } = await this.db.query<{ turns: number }>(
      `SELECT count(*)::int AS turns FROM agent_runs WHERE conversation_id = $1 AND status = 'ok'`,
      [conversationId],
    );
    return firstRow(rows, 'COUNT agent_runs').turns;
  }

  async loadHistory(conversationId: string): Promise<readonly LlmMessage[]> {
    const { rows } = await this.db.query<{ role: string; content: unknown }>(
      `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY seq`,
      [conversationId],
    );
    return rows.map((row) => parseStoredMessage(row.role, row.content));
  }

  async appendMessages(conversationId: string, messages: readonly NewMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.db.transaction(async (tx) => {
      // Row lock: concurrent appends to one conversation are serialized, so `seq` stays gapless.
      const locked = await tx.query(`SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`, [
        conversationId,
      ]);
      if (locked.rowCount === 0) throw new NotFoundError('conversation', conversationId);
      await tx.query(
        `INSERT INTO messages (id, conversation_id, seq, role, content, provider, model, created_at)
         SELECT m.id, $1,
                (SELECT COALESCE(max(seq) + 1, 0) FROM messages WHERE conversation_id = $1)
                  + m.ord - 1,
                m.role, m.content, m.provider, m.model, m.created_at
         FROM unnest($2::uuid[], $3::text[], $4::jsonb[], $5::text[], $6::text[],
                     $7::timestamptz[])
              WITH ORDINALITY AS m(id, role, content, provider, model, created_at, ord)`,
        [
          conversationId,
          messages.map((entry) => entry.id),
          messages.map((entry) => storedRole(entry.message)),
          messages.map((entry) => json(entry.message.content)),
          messages.map((entry) => entry.provider),
          messages.map((entry) => entry.model),
          messages.map((entry) => entry.createdAt),
        ],
      );
    });
  }

  async updateAfterTurn(conversationId: string, update: ConversationUpdate): Promise<void> {
    const result = await this.db.query(
      `UPDATE conversations
       SET trip_brief = $2,
           title = COALESCE(title, $3),
           updated_at = GREATEST(updated_at, $4)
       WHERE id = $1`,
      [conversationId, json(update.brief), update.titleIfUnset, update.updatedAt],
    );
    if (result.rowCount === 0) throw new NotFoundError('conversation', conversationId);
  }
}

function firstRow<Row>(rows: readonly Row[], statement: string): Row {
  const [row] = rows;
  if (row === undefined) throw new Error(`${statement} returned no row`);
  return row;
}
