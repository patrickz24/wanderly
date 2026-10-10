import {
  AgentEventSchema,
  ConversationSummarySchema,
  GetConversationResponseSchema,
} from '@wanderly/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import {
  createCreateConversation,
  createGetConversation,
  createListConversations,
} from '../../src/application/conversations.js';
import { createSendMessage } from '../../src/application/send-message.js';
import { createSubmitFeedback } from '../../src/application/submit-feedback.js';
import { SYSTEM_CLOCK } from '../../src/domain/ports/tracer.js';
import { createPgPersistence } from '../../src/infrastructure/persistence/index.js';
import {
  FAKE_KNOWLEDGE,
  FAKE_RETRIEVER,
  TEST_LIMITS,
  TEST_PRICING,
  fakeLlm,
  scriptedRunAgent,
} from '../agent-fakes.js';
import { exchange, recordingTracer, sequentialIds } from '../application-fakes.js';
import { fakeProbe, testConfig } from '../support.js';
import { createScratchDatabase, migrate, type ScratchDatabase } from './db.js';

/**
 * The conversation API end to end over real Postgres: HTTP routes, use cases and repositories,
 * with only the agent runtime scripted (no model is ever called).
 */

let scratch: ScratchDatabase;
let pool: pg.Pool;
let app: App;
const tracer = recordingTracer('trace-int');

beforeAll(async () => {
  scratch = await createScratchDatabase();
  await migrate(scratch.url, 'up');
  pool = new pg.Pool({ connectionString: scratch.url, max: 4 });
  const persistence = createPgPersistence(pool);
  const ids = sequentialIds();
  const deps = { conversations: persistence.conversations, ids, clock: SYSTEM_CLOCK };
  app = await buildApp({
    config: testConfig({ DATABASE_URL: scratch.url }),
    readinessProbe: fakeProbe(),
    api: {
      useCases: {
        createConversation: createCreateConversation(deps),
        listConversations: createListConversations(deps),
        getConversation: createGetConversation(deps),
        sendMessage: createSendMessage({
          conversations: persistence.conversations,
          runs: persistence.runs,
          unitOfWork: persistence.unitOfWork,
          ledger: persistence.ledger,
          agent: {
            runAgent: scriptedRunAgent(),
            llm: fakeLlm(),
            retriever: FAKE_RETRIEVER,
            knowledge: FAKE_KNOWLEDGE,
            limits: TEST_LIMITS,
            pricing: TEST_PRICING,
            canaryToken: 'canary-0123456789abcdef',
          },
          tracer,
          clock: SYSTEM_CLOCK,
          ids,
          dailyBudgetUsd: 2,
        }),
        submitFeedback: createSubmitFeedback({
          runs: persistence.runs,
          feedback: persistence.feedback,
          tracer,
          clock: SYSTEM_CLOCK,
        }),
      },
    },
  });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await scratch?.drop();
});

describe('conversation API over Postgres', () => {
  it('creates a conversation, streams a turn, persists it and accepts feedback', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/conversations' });
    expect(created.statusCode).toBe(201);
    const conversation = ConversationSummarySchema.parse(created.json());
    const cookie = String(created.headers['set-cookie']).split(';')[0] ?? '';

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: { cookie },
      payload: { text: 'Sicily in May?' },
    });
    expect(streamed.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const events = streamed.body
      .split('\n\n')
      .filter((block) => block.startsWith('event: '))
      .map((block) => AgentEventSchema.parse(JSON.parse(block.split('\ndata: ')[1] ?? '')));
    expect(events.map((event) => event.type).at(-1)).toBe('run.finished');
    const runId = events[0]?.type === 'run.started' ? events[0].runId : '';

    const detail = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}`,
      headers: { cookie },
    });
    const body = GetConversationResponseSchema.parse(detail.json());
    expect(body.title).toBe('Sicily in May?');
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(body.messages[1]).toMatchObject({
      runId,
      run: { traceId: 'trace-int' },
      feedback: null,
    });

    const history = await pool.query<{ seq: number; role: string; content: unknown }>(
      'SELECT seq, role, content FROM messages WHERE conversation_id = $1 ORDER BY seq',
      [conversation.id],
    );
    expect(history.rows.map((row) => row.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(history.rows.map((row) => row.content)).toEqual(
      exchange('Sicily in May?').map((message) => message.content),
    );

    const feedback = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/feedback`,
      headers: { cookie },
      payload: { rating: 1, comment: null },
    });
    expect(feedback.statusCode).toBe(204);
    const reloaded = GetConversationResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/conversations/${conversation.id}`,
          headers: { cookie },
        })
      ).json(),
    );
    expect(reloaded.messages[1]).toMatchObject({ feedback: { rating: 1 } });

    const spent = await pool.query<{ spent: number }>(
      'SELECT sum(cost_usd)::float8 AS spent FROM agent_runs',
    );
    expect(spent.rows[0]?.spent).toBe(0.000615);
  });

  it("hides one session's conversations and runs from another", async () => {
    const created = await app.inject({ method: 'POST', url: '/api/conversations' });
    const { id } = ConversationSummarySchema.parse(created.json());

    const stranger = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    const list = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: String(stranger.headers['set-cookie']).split(';')[0] ?? '' },
    });

    expect(stranger.statusCode).toBe(404);
    expect(list.json()).toEqual({ conversations: [] });
  });
});
