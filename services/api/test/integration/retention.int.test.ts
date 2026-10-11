import { EMPTY_TRIP_BRIEF } from '@wanderly/contracts';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NewMessage } from '../../src/application/ports/conversations.js';
import type { RunRecord } from '../../src/application/ports/runs.js';
import { createPurgeExpiredConversations } from '../../src/application/purge-expired-conversations.js';
import { utcDayBounds } from '../../src/application/run-accounting.js';
import { NotFoundError } from '../../src/domain/errors.js';
import {
  createPgPersistence,
  type Persistence,
} from '../../src/infrastructure/persistence/index.js';
import {
  ANSWER,
  SESSION_A,
  SOURCES,
  TOOL_CALLS,
  exchange,
  manualClock,
  sequentialIds,
} from '../application-fakes.js';
import { createScratchDatabase, migrate, type ScratchDatabase } from './db.js';

const NOW = '2026-10-11T10:00:00.000Z';
/** NOW minus the default 30 days of retention. */
const CUTOFF = '2026-09-11T10:00:00.000Z';

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

function purge(retentionDays = 30, batchSize?: number) {
  return createPurgeExpiredConversations({
    store: store.retention,
    clock: manualClock(NOW),
    retentionDays,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}

function runRecord(conversationId: string, overrides: Partial<RunRecord>): RunRecord {
  return {
    id: ids.newId(),
    conversationId,
    traceId: null,
    model: 'fake-model',
    promptVersion: 'agent-v1-test',
    status: 'error',
    responseType: null,
    errorCode: 'LLM_TIMEOUT',
    failureReason: 'llm_timeout',
    steps: 1,
    repairs: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.01,
    latencyMs: 1_000,
    validFirstTry: null,
    citationsOk: null,
    userText: 'Sicily in May?',
    userMessageId: null,
    assistantMessageId: null,
    response: null,
    sources: [],
    toolCalls: [],
    createdAt: at(NOW),
    ...overrides,
  };
}

/** A conversation with one completed turn (4 messages, one run) at `iso`, optionally rated. */
async function conversationWithTurn(iso: string, { rated = false } = {}) {
  const when = at(iso);
  const conversation = await store.conversations.create({
    id: ids.newId(),
    sessionId: SESSION_A,
    brief: EMPTY_TRIP_BRIEF,
    now: when,
  });
  const messages = exchange('Sicily in May?').map((message): NewMessage => ({
    id: ids.newId(),
    message,
    provider: message.role === 'assistant' ? 'fake' : null,
    model: message.role === 'assistant' ? 'fake-model' : null,
    createdAt: when,
  }));
  const run = runRecord(conversation.id, {
    status: 'ok',
    responseType: 'answer',
    errorCode: null,
    failureReason: null,
    validFirstTry: true,
    citationsOk: true,
    userMessageId: messages[0]?.id ?? null,
    assistantMessageId: messages[3]?.id ?? null,
    response: ANSWER,
    sources: SOURCES,
    toolCalls: TOOL_CALLS,
    costUsd: 0.02,
    createdAt: when,
  });
  await store.unitOfWork.inTransaction(async ({ conversations, runs }) => {
    await conversations.appendMessages(conversation.id, messages);
    await conversations.updateAfterTurn(conversation.id, {
      brief: ANSWER.brief,
      titleIfUnset: 'Sicily in May?',
      updatedAt: when,
    });
    await runs.save(run);
  });
  if (rated) {
    await store.feedback.upsert({ runId: run.id, rating: -1, comment: 'meh', createdAt: when });
  }
  return { id: conversation.id, run };
}

async function count(table: 'conversations' | 'messages' | 'agent_runs' | 'feedback') {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n;
}

async function conversationIds(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM conversations ORDER BY id`);
  return rows.map((row) => row.id);
}

const todaysSpend = () => {
  const { from, to } = utcDayBounds(at(NOW));
  return store.ledger.spentUsd(from, to);
};

describe('retention purge (Postgres)', () => {
  it('deletes conversations inactive past the window with their messages, runs and feedback', async () => {
    const expired = await conversationWithTurn('2026-09-01T08:00:00.000Z', { rated: true });
    const recent = await conversationWithTurn('2026-10-01T08:00:00.000Z', { rated: true });
    // `updated_at < cutoff` is strict: a conversation active exactly at the cutoff stays.
    const boundary = await conversationWithTurn(CUTOFF);

    const result = await purge().execute();

    expect(result).toMatchObject({
      cutoff: at(CUTOFF),
      conversations: 1,
      messages: 4,
      runs: 1,
      feedback: 1,
      batches: 1,
    });
    expect(await conversationIds()).toEqual([recent.id, boundary.id].sort());
    expect(await count('messages')).toBe(8);
    expect(await count('agent_runs')).toBe(2);
    expect(await count('feedback')).toBe(1);
    const { rows } = await pool.query(`SELECT 1 FROM agent_runs WHERE conversation_id = $1`, [
      expired.id,
    ]);
    expect(rows).toEqual([]);
  });

  it("never deletes a run that today's spend includes", async () => {
    // A failed run does not move updated_at: this conversation looks 40 days idle, yet one of its
    // runs was recorded today and counts against the daily cap.
    const idleButBilledToday = await conversationWithTurn('2026-09-01T08:00:00.000Z');
    await store.runs.save(
      runRecord(idleButBilledToday.id, { createdAt: at('2026-10-11T00:00:00.000Z'), costUsd: 0.4 }),
    );
    // Same, with a failed run inside the window but before today.
    const billedLastWeek = await conversationWithTurn('2026-09-01T08:00:00.000Z');
    await store.runs.save(
      runRecord(billedLastWeek.id, { createdAt: at('2026-10-04T12:00:00.000Z'), costUsd: 0.3 }),
    );
    // Only runs older than the cutoff: expired.
    const expired = await conversationWithTurn('2026-09-01T08:00:00.000Z');
    await store.runs.save(
      runRecord(expired.id, { createdAt: at('2026-09-02T08:00:00.000Z'), costUsd: 0.5 }),
    );
    const spentBefore = await todaysSpend();

    for (const retentionDays of [30, 1]) {
      const result = await purge(retentionDays).execute();
      expect(await todaysSpend()).toBe(spentBefore);
      expect(await conversationIds()).toContain(idleButBilledToday.id);
      if (retentionDays === 30) expect(result).toMatchObject({ conversations: 1, runs: 2 });
    }
    expect(spentBefore).toBeCloseTo(0.4, 6);
    expect(await conversationIds()).toEqual([idleButBilledToday.id]);
  });

  it('deletes in batches until no expired conversation is left', async () => {
    for (let day = 1; day <= 5; day += 1) {
      await conversationWithTurn(`2026-09-0${day}T08:00:00.000Z`);
    }
    await conversationWithTurn('2026-10-10T08:00:00.000Z');

    const result = await purge(30, 2).execute();

    expect(result).toMatchObject({ conversations: 5, messages: 20, runs: 5, batches: 3 });
    expect(await count('conversations')).toBe(1);
  });

  it('counts without deleting in a dry run', async () => {
    await conversationWithTurn('2026-09-01T08:00:00.000Z', { rated: true });
    await conversationWithTurn('2026-09-02T08:00:00.000Z');
    await conversationWithTurn('2026-10-02T08:00:00.000Z');

    const dryRun = await purge().execute({ dryRun: true });

    expect(dryRun).toMatchObject({
      dryRun: true,
      conversations: 2,
      messages: 8,
      runs: 2,
      feedback: 1,
      batches: 0,
    });
    expect(await count('conversations')).toBe(3);
    expect(await purge().execute()).toMatchObject({ conversations: 2, messages: 8, runs: 2 });
  });

  it('keeps a conversation marked active by a starting run; a purged one cannot be marked', async () => {
    const resumed = await conversationWithTurn('2026-09-01T08:00:00.000Z');
    const abandoned = await conversationWithTurn('2026-09-01T08:00:00.000Z');
    await store.conversations.markActive(resumed.id, at(NOW));

    await purge().execute();

    expect(await conversationIds()).toEqual([resumed.id]);
    await expect(store.conversations.markActive(abandoned.id, at(NOW))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('skips a conversation that a request holds locked instead of waiting for it', async () => {
    const locked = await conversationWithTurn('2026-09-01T08:00:00.000Z');
    await conversationWithTurn('2026-09-02T08:00:00.000Z');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`, [locked.id]);

      const first = await purge().execute();

      expect(first.conversations).toBe(1);
      expect(await conversationIds()).toEqual([locked.id]);
      await writer.query('COMMIT');
    } finally {
      writer.release();
    }
    expect((await purge().execute()).conversations).toBe(1);
    expect(await conversationIds()).toEqual([]);
  });
});
