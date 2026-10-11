import { EMPTY_TRIP_BRIEF } from '@wanderly/contracts';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NewMessage } from '../../src/application/ports/conversations.js';
import type { RunRecord } from '../../src/application/ports/runs.js';
import { NotFoundError } from '../../src/domain/errors.js';
import type { LlmMessage } from '../../src/domain/ports/llm.js';
import {
  createPgPersistence,
  type Persistence,
} from '../../src/infrastructure/persistence/index.js';
import {
  ANSWER,
  SESSION_A,
  SESSION_B,
  SOURCES,
  TOOL_CALLS,
  exchange,
  sequentialIds,
} from '../application-fakes.js';
import { createScratchDatabase, migrate, type ScratchDatabase } from './db.js';

let scratch: ScratchDatabase;
let pool: pg.Pool;
let store: Persistence;
let ids: ReturnType<typeof sequentialIds>;

beforeAll(async () => {
  scratch = await createScratchDatabase();
  await migrate(scratch.url, 'up');
  pool = new pg.Pool({ connectionString: scratch.url, max: 4 });
  store = createPgPersistence(pool);
});

afterAll(async () => {
  await pool?.end();
  await scratch?.drop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE conversations CASCADE');
  ids = sequentialIds();
});

const at = (iso: string) => new Date(iso);

async function newConversation(sessionId = SESSION_A, now = at('2026-10-10T09:00:00Z')) {
  return store.conversations.create({ id: ids.newId(), sessionId, brief: EMPTY_TRIP_BRIEF, now });
}

function toNew(messages: readonly LlmMessage[], createdAt = at('2026-10-10T09:00:01Z')) {
  return messages.map((message): NewMessage => ({
    id: ids.newId(),
    message,
    provider: message.role === 'assistant' ? 'fake' : null,
    model: message.role === 'assistant' ? 'fake-model' : null,
    createdAt,
  }));
}

function runRecord(conversationId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: ids.newId(),
    conversationId,
    traceId: 'trace-1',
    model: 'fake-model',
    promptVersion: 'agent-v1-test',
    status: 'error',
    responseType: null,
    errorCode: 'LLM_TIMEOUT',
    failureReason: 'run_deadline',
    steps: 3,
    repairs: 0,
    toolCallCount: 2,
    toolErrorCount: 1,
    usage: { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 50 },
    costUsd: 0.000321,
    latencyMs: 90_000.4,
    validFirstTry: null,
    citationsOk: null,
    userText: 'Sicily in May?',
    userMessageId: null,
    assistantMessageId: null,
    response: null,
    sources: [],
    toolCalls: TOOL_CALLS,
    createdAt: at('2026-10-10T09:00:02Z'),
    ...overrides,
  };
}

/** Appends a full exchange and records its successful run, in one transaction. */
async function completedTurn(conversationId: string, text: string, createdAt: Date) {
  const messages = toNew(exchange(text), createdAt);
  const run = runRecord(conversationId, {
    status: 'ok',
    responseType: 'answer',
    errorCode: null,
    failureReason: null,
    validFirstTry: true,
    citationsOk: true,
    userText: text,
    userMessageId: messages[0]?.id ?? null,
    assistantMessageId: messages[3]?.id ?? null,
    response: ANSWER,
    sources: SOURCES,
    createdAt,
  });
  await store.unitOfWork.inTransaction(async ({ conversations, runs }) => {
    await conversations.appendMessages(conversationId, messages);
    await runs.save(run);
  });
  return { messages, run };
}

describe('PgConversationRepository', () => {
  it('creates conversations and only shows them to their session', async () => {
    const first = await newConversation(SESSION_A, at('2026-10-10T09:00:00Z'));
    const second = await newConversation(SESSION_A, at('2026-10-10T10:00:00Z'));
    await newConversation(SESSION_B);

    expect(first).toEqual({
      id: first.id,
      sessionId: SESSION_A,
      title: null,
      brief: EMPTY_TRIP_BRIEF,
      createdAt: at('2026-10-10T09:00:00Z'),
      updatedAt: at('2026-10-10T09:00:00Z'),
    });
    expect((await store.conversations.listForSession(SESSION_A, 10)).map((c) => c.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await store.conversations.listForSession(SESSION_A, 1)).toHaveLength(1);
    expect(await store.conversations.findForSession(first.id, SESSION_A)).toEqual(first);
    expect(await store.conversations.findForSession(first.id, SESSION_B)).toBeNull();
  });

  it('treats the legacy empty-object brief as an empty brief', async () => {
    const id = ids.newId();
    await pool.query(`INSERT INTO conversations (id, session_id) VALUES ($1, $2)`, [id, SESSION_A]);

    expect((await store.conversations.findForSession(id, SESSION_A))?.brief).toEqual(
      EMPTY_TRIP_BRIEF,
    );
  });

  it('appends messages with consecutive sequence numbers and replays them verbatim', async () => {
    const { id } = await newConversation();
    const first = exchange('Sicily in May?');
    const second = exchange('And in June?');

    await store.conversations.appendMessages(id, toNew(first));
    const before = await pool.query('SELECT * FROM messages ORDER BY seq');
    await store.conversations.appendMessages(id, toNew(second));

    const { rows } = await pool.query<{ seq: number; role: string }>(
      'SELECT seq, role FROM messages WHERE conversation_id = $1 ORDER BY seq',
      [id],
    );
    expect(rows).toEqual([
      { seq: 0, role: 'user' },
      { seq: 1, role: 'assistant' },
      { seq: 2, role: 'tool' },
      { seq: 3, role: 'assistant' },
      { seq: 4, role: 'user' },
      { seq: 5, role: 'assistant' },
      { seq: 6, role: 'tool' },
      { seq: 7, role: 'assistant' },
    ]);
    // Append-only: the earlier rows are byte-for-byte unchanged.
    const after = await pool.query('SELECT * FROM messages WHERE seq < 4 ORDER BY seq');
    expect(after.rows).toEqual(before.rows);
    // Provider blocks round-trip exactly, unknown keys included.
    expect(await store.conversations.loadHistory(id)).toEqual([...first, ...second]);
  });

  it('keeps sequence numbers gapless under concurrent appends', async () => {
    const { id } = await newConversation();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.conversations.appendMessages(id, toNew(exchange(`question ${index}`))),
      ),
    );

    const { rows } = await pool.query<{ seq: number }>(
      'SELECT seq FROM messages WHERE conversation_id = $1 ORDER BY seq',
      [id],
    );
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('refuses to append to an unknown conversation', async () => {
    await expect(
      store.conversations.appendMessages(ids.newId(), toNew(exchange('hello'))),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ignores an empty append', async () => {
    const { id } = await newConversation();
    await store.conversations.appendMessages(id, []);
    expect(await store.conversations.loadHistory(id)).toEqual([]);
  });

  it('updates the brief, sets the title once and keeps updated_at monotonic', async () => {
    const { id } = await newConversation(SESSION_A, at('2026-10-10T09:00:00Z'));

    await store.conversations.updateAfterTurn(id, {
      brief: ANSWER.brief,
      titleIfUnset: 'Sicily in May?',
      updatedAt: at('2026-10-10T09:05:00Z'),
    });
    await store.conversations.updateAfterTurn(id, {
      brief: ANSWER.brief,
      titleIfUnset: 'Something else',
      updatedAt: at('2026-10-10T09:01:00Z'),
    });

    expect(await store.conversations.findForSession(id, SESSION_A)).toMatchObject({
      title: 'Sicily in May?',
      brief: ANSWER.brief,
      updatedAt: at('2026-10-10T09:05:00Z'),
    });
    await expect(
      store.conversations.updateAfterTurn(ids.newId(), {
        brief: ANSWER.brief,
        titleIfUnset: 'x',
        updatedAt: at('2026-10-10T09:05:00Z'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists completed turns with their display payload and counts them', async () => {
    const { id } = await newConversation();
    const one = await completedTurn(id, 'Sicily in May?', at('2026-10-10T09:01:00Z'));
    await store.runs.save(runRecord(id, { createdAt: at('2026-10-10T09:02:00Z') }));
    const two = await completedTurn(id, 'And hiking?', at('2026-10-10T09:03:00Z'));
    await store.feedback.upsert({
      runId: one.run.id,
      rating: 1,
      comment: null,
      createdAt: at('2026-10-10T09:04:00Z'),
    });

    const turns = await store.conversations.listTurns(id);

    expect(turns).toEqual([
      {
        runId: one.run.id,
        userMessageId: one.messages[0]?.id,
        userText: 'Sicily in May?',
        userCreatedAt: at('2026-10-10T09:01:00Z'),
        assistantMessageId: one.messages[3]?.id,
        response: ANSWER,
        sources: SOURCES,
        toolCalls: TOOL_CALLS,
        completedAt: at('2026-10-10T09:01:00Z'),
        run: {
          steps: 3,
          usage: {
            inputTokens: 1_200,
            outputTokens: 300,
            cacheReadTokens: 900,
            cacheWriteTokens: 50,
          },
          costUsd: 0.000321,
          latencyMs: 90_000,
          traceId: 'trace-1',
        },
        feedbackRating: 1,
      },
      expect.objectContaining({ runId: two.run.id, userText: 'And hiking?', feedbackRating: null }),
    ]);
    expect(await store.conversations.countCompletedTurns(id)).toBe(2);
  });

  it('fails loudly on a stored display payload that no longer matches the contracts', async () => {
    const { id } = await newConversation();
    const { run } = await completedTurn(id, 'Sicily?', at('2026-10-10T09:01:00Z'));
    await pool.query(`UPDATE agent_runs SET response = '{"type":"weird"}' WHERE id = $1`, [run.id]);

    await expect(store.conversations.listTurns(id)).rejects.toThrow(
      `Run ${run.id} has an invalid stored display payload`,
    );
  });
});

describe('unit of work', () => {
  it('rolls back the appended messages when recording the run fails', async () => {
    const { id } = await newConversation();
    const messages = toNew(exchange('Sicily?'));

    await expect(
      store.unitOfWork.inTransaction(async ({ conversations, runs }) => {
        await conversations.appendMessages(id, messages);
        // References a message that does not exist: the foreign key rejects the run.
        await runs.save(runRecord(id, { userMessageId: ids.newId() }));
      }),
    ).rejects.toMatchObject({ code: '23503' });

    expect(await store.conversations.loadHistory(id)).toEqual([]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM agent_runs');
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe('PgRunRepository, PgSpendLedger and PgFeedbackRepository', () => {
  it('records every accounting field of a failed run', async () => {
    const { id } = await newConversation();
    const run = runRecord(id, { errorCode: 'CANCELLED', failureReason: 'cancelled' });

    await store.runs.save(run);

    const { rows } = await pool.query('SELECT * FROM agent_runs WHERE id = $1', [run.id]);
    expect(rows[0]).toMatchObject({
      prompt_version: 'agent-v1-test',
      status: 'error',
      error_code: 'CANCELLED',
      failure_reason: 'cancelled',
      steps: 3,
      tool_calls: 2,
      tool_errors: 1,
      input_tokens: 1_200,
      output_tokens: 300,
      cache_read_tokens: 900,
      cache_write_tokens: 50,
      cost_usd: '0.000321',
      latency_ms: 90_000,
      user_text: 'Sicily in May?',
      response: null,
      sources: [],
      tool_call_log: TOOL_CALLS,
    });
  });

  it('shows a run only to the session that owns its conversation', async () => {
    const { id } = await newConversation(SESSION_A);
    const run = runRecord(id);
    await store.runs.save(run);

    expect(await store.runs.findForSession(run.id, SESSION_A)).toEqual({
      id: run.id,
      traceId: 'trace-1',
    });
    expect(await store.runs.findForSession(run.id, SESSION_B)).toBeNull();
    expect(await store.runs.findForSession(ids.newId(), SESSION_A)).toBeNull();
  });

  it('sums the spending of the given UTC day only, across conversations and sessions', async () => {
    const a = await newConversation(SESSION_A);
    const b = await newConversation(SESSION_B);
    await store.runs.save(
      runRecord(a.id, { costUsd: 0.25, createdAt: at('2026-10-09T23:59:59Z') }),
    );
    await store.runs.save(runRecord(a.id, { costUsd: 0.5, createdAt: at('2026-10-10T00:00:00Z') }));
    await store.runs.save(
      runRecord(b.id, { costUsd: 0.125, createdAt: at('2026-10-10T23:59:59Z') }),
    );
    await store.runs.save(runRecord(b.id, { costUsd: 1, createdAt: at('2026-10-11T00:00:00Z') }));

    await expect(
      store.ledger.spentUsd(at('2026-10-10T00:00:00Z'), at('2026-10-11T00:00:00Z')),
    ).resolves.toBe(0.625);
    await expect(
      store.ledger.spentUsd(at('2026-10-12T00:00:00Z'), at('2026-10-13T00:00:00Z')),
    ).resolves.toBe(0);
  });

  it('keeps one rating per run, replaced by the latest', async () => {
    const { id } = await newConversation();
    const run = runRecord(id);
    await store.runs.save(run);

    await store.feedback.upsert({
      runId: run.id,
      rating: 1,
      comment: 'Great',
      createdAt: at('2026-10-10T10:00:00Z'),
    });
    await store.feedback.upsert({
      runId: run.id,
      rating: -1,
      comment: null,
      createdAt: at('2026-10-10T10:01:00Z'),
    });

    const { rows } = await pool.query('SELECT rating, comment, created_at FROM feedback');
    expect(rows).toEqual([{ rating: -1, comment: null, created_at: at('2026-10-10T10:01:00Z') }]);
  });
});
