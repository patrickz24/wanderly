import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AgentEventSchema,
  ApiErrorResponseSchema,
  ConversationSummarySchema,
  GetConversationResponseSchema,
  type AgentEvent,
} from '@wanderly/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_KNOWLEDGE,
  FAKE_RETRIEVER,
  TEST_LIMITS,
  TEST_PRICING,
  errorResult,
  fakeLlm,
  okResult,
  scriptedRunAgent,
} from '../../../test/agent-fakes.js';
import {
  InMemoryStore,
  manualClock,
  recordingTracer,
  sequentialIds,
} from '../../../test/application-fakes.js';
import { fakeProbe, memoryLog, testConfig, type MemoryLog } from '../../../test/support.js';
import { buildApp, type App } from '../../app.js';
import {
  createCreateConversation,
  createGetConversation,
  createListConversations,
} from '../../application/conversations.js';
import type { RunAgent } from '../../application/ports/agent-runner.js';
import { createSendMessage } from '../../application/send-message.js';
import { createSubmitFeedback } from '../../application/submit-feedback.js';
import { LlmTimeoutError } from '../../domain/errors.js';
import type { LlmPort } from '../../domain/ports/llm.js';
import { SESSION_COOKIE } from '../session.js';

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface StartOptions {
  readonly runAgent?: RunAgent;
  readonly llm?: LlmPort;
  readonly env?: Record<string, string>;
  readonly dailyBudgetUsd?: number;
  readonly maxUserTurns?: number;
  readonly log?: MemoryLog;
  readonly heartbeatMs?: number;
}

async function start(options: StartOptions = {}) {
  const store = new InMemoryStore();
  const ids = sequentialIds();
  const clock = manualClock();
  const tracer = recordingTracer('trace-xyz');
  const runAgent = options.runAgent ?? scriptedRunAgent();
  const deps = { conversations: store.conversationRepository, ids, clock };
  app = await buildApp({
    config: testConfig({
      LOG_LEVEL: options.log === undefined ? 'silent' : 'info',
      ...options.env,
    }),
    readinessProbe: fakeProbe(),
    ...(options.log === undefined ? {} : { logDestination: options.log }),
    api: {
      useCases: {
        createConversation: createCreateConversation(deps),
        listConversations: createListConversations(deps),
        getConversation: createGetConversation(deps),
        sendMessage: createSendMessage({
          conversations: store.conversationRepository,
          runs: store.runRepository,
          unitOfWork: store.unitOfWork,
          ledger: store.ledger,
          agent: {
            runAgent,
            llm: options.llm ?? fakeLlm(),
            retriever: FAKE_RETRIEVER,
            knowledge: FAKE_KNOWLEDGE,
            limits: TEST_LIMITS,
            pricing: TEST_PRICING,
            canaryToken: 'canary-0123456789abcdef',
          },
          tracer,
          clock,
          ids,
          dailyBudgetUsd: options.dailyBudgetUsd ?? 2,
          ...(options.maxUserTurns === undefined ? {} : { maxUserTurns: options.maxUserTurns }),
        }),
        submitFeedback: createSubmitFeedback({
          runs: store.runRepository,
          feedback: store.feedbackRepository,
          tracer,
          clock,
        }),
      },
      ...(options.heartbeatMs === undefined ? {} : { sseHeartbeatMs: options.heartbeatMs }),
    },
  });
  return { server: app, store, tracer };
}

/** `name=value` of the session cookie set by a response. */
function sessionCookie(setCookie: string | string[] | number | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
  const match = new RegExp(`${SESSION_COOKIE}=[^;]+`).exec(header);
  if (match === null) throw new Error(`no ${SESSION_COOKIE} cookie in ${header}`);
  return match[0];
}

async function newConversation(server: App, cookie?: string) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/conversations',
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  expect(response.statusCode).toBe(201);
  return {
    conversation: ConversationSummarySchema.parse(response.json()),
    cookie: cookie ?? sessionCookie(response.headers['set-cookie']),
  };
}

function postMessage(server: App, conversationId: string, cookie: string, text = 'Sicily in May?') {
  return server.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie, 'x-request-id': 'req-42' },
    payload: { text },
  });
}

interface RawSseEvent {
  readonly event: string;
  readonly data: AgentEvent;
}

/** Parses a complete `text/event-stream` body; every data line must be a valid AgentEvent. */
function parseSse(body: string): { events: RawSseEvent[]; comments: string[] } {
  const events: RawSseEvent[] = [];
  const comments: string[] = [];
  for (const block of body.split('\n\n').filter((chunk) => chunk !== '')) {
    const lines = block.split('\n');
    if (lines.every((line) => line.startsWith(':'))) {
      comments.push(...lines);
      continue;
    }
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? '';
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '';
    events.push({ event, data: AgentEventSchema.parse(JSON.parse(data)) });
  }
  return { events, comments };
}

describe('anonymous session', () => {
  it('creates a signed, httpOnly, SameSite=Lax session cookie scoped to the API', async () => {
    const { server } = await start();

    const response = await server.inject({ method: 'GET', url: '/api/conversations' });

    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]{43}\\.[^;]+;`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).not.toContain('Secure');
  });

  it('marks the cookie Secure in production', async () => {
    const { server } = await start({ env: { NODE_ENV: 'production' } });
    const response = await server.inject({ method: 'GET', url: '/api/conversations' });
    expect(String(response.headers['set-cookie'])).toContain('Secure');
  });

  it('keeps the session across requests and does not reissue the cookie', async () => {
    const { server } = await start();
    const { conversation, cookie } = await newConversation(server);

    const list = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie },
    });

    expect(list.headers['set-cookie']).toBeUndefined();
    expect(list.json()).toEqual({ conversations: [conversation] });
  });

  it('replaces a forged cookie with a new session and logs it', async () => {
    const log = memoryLog();
    const { server } = await start({ log });
    const { cookie } = await newConversation(server);
    const forged = cookie.replace(/\.[^.]+$/, '.forgedsignature');

    const list = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: forged },
    });

    expect(list.json()).toEqual({ conversations: [] });
    expect(sessionCookie(list.headers['set-cookie'])).not.toBe(cookie);
    expect(
      log
        .entries()
        .some((entry) => entry['msg'] === 'invalid session cookie, issuing a new session'),
    ).toBe(true);
  });
});

describe('session isolation', () => {
  it("answers 404 for another session's conversation, on every route", async () => {
    const { server, store } = await start();
    const alice = await newConversation(server);
    await postMessage(server, alice.conversation.id, alice.cookie);
    const bob = await newConversation(server, undefined);
    const runId = store.runs[0]?.id ?? '';

    const read = await server.inject({
      method: 'GET',
      url: `/api/conversations/${alice.conversation.id}`,
      headers: { cookie: bob.cookie },
    });
    const write = await postMessage(server, alice.conversation.id, bob.cookie);
    const feedback = await server.inject({
      method: 'POST',
      url: `/api/runs/${runId}/feedback`,
      headers: { cookie: bob.cookie },
      payload: { rating: -1, comment: null },
    });

    for (const response of [read, write, feedback]) {
      expect(response.statusCode).toBe(404);
      expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    }
    expect(write.headers['content-type']).toContain('application/json');
    expect(store.runs).toHaveLength(1);
    expect(store.feedback.size).toBe(0);
  });

  it('validates ids and bodies before doing anything', async () => {
    const { server } = await start();
    const { conversation, cookie } = await newConversation(server);

    const badId = await server.inject({
      method: 'GET',
      url: '/api/conversations/not-a-uuid',
      headers: { cookie },
    });
    const empty = await postMessage(server, conversation.id, cookie, '   ');
    const tooLong = await postMessage(server, conversation.id, cookie, 'x'.repeat(2_001));
    const badRating = await server.inject({
      method: 'POST',
      url: `/api/runs/${conversation.id}/feedback`,
      headers: { cookie },
      payload: { rating: 5, comment: null },
    });

    for (const response of [badId, empty, tooLong, badRating]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });
});

describe('POST /api/conversations/:id/messages (SSE)', () => {
  it('streams the run as Server-Sent Events, one validated JSON event per message', async () => {
    const { server } = await start();
    const { conversation, cookie } = await newConversation(server);

    const response = await postMessage(server, conversation.id, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.headers['x-request-id']).toBe('req-42');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const { events } = parseSse(response.body);
    expect(events.map((event) => event.event)).toEqual([
      'run.started',
      'tool.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
      'response',
      'run.finished',
    ]);
    expect(events.every((event) => event.event === event.data.type)).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ type: 'run.finished', traceId: 'trace-xyz' });
  });

  it('makes the completed turn visible in the conversation', async () => {
    const { server } = await start();
    const { conversation, cookie } = await newConversation(server);
    const { events } = parseSse((await postMessage(server, conversation.id, cookie)).body);
    const response = events.find((event) => event.data.type === 'response')?.data;

    const detail = await server.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}`,
      headers: { cookie },
    });

    expect(detail.statusCode).toBe(200);
    const body = GetConversationResponseSchema.parse(detail.json());
    expect(body.title).toBe('Sicily in May?');
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    if (response?.type !== 'response') throw new Error('expected a response event');
    // The loaded answer is the streamed one, plus its run stats and (absent) rating.
    expect(response.message.run).toBeUndefined();
    expect(body.messages[1]).toEqual({
      ...response.message,
      run: {
        steps: 2,
        usage: {
          inputTokens: 3_000,
          outputTokens: 600,
          cacheReadTokens: 1_500,
          cacheWriteTokens: 0,
        },
        costUsd: 0.000615,
        latencyMs: 1_234,
        traceId: 'trace-xyz',
      },
      feedback: null,
    });
  });

  it('ends a failed run with an error event carrying a curated message only', async () => {
    const { server } = await start({
      runAgent: scriptedRunAgent((input) =>
        errorResult(input, new LlmTimeoutError(45_000), 'llm_timeout'),
      ),
    });
    const { conversation, cookie } = await newConversation(server);

    const { events } = parseSse((await postMessage(server, conversation.id, cookie)).body);

    const runId = events[0]?.data.type === 'run.started' ? events[0].data.runId : null;
    expect(events.at(-1)?.data).toEqual({
      type: 'error',
      runId,
      error: { code: 'LLM_TIMEOUT', message: 'The assistant took too long. Please try again.' },
    });
    expect(events.map((event) => event.event)).not.toContain('response');
  });

  it('hides unexpected failures behind INTERNAL_ERROR and logs them', async () => {
    const log = memoryLog();
    const { server } = await start({
      log,
      runAgent: async () => {
        throw new Error('pg: password authentication failed for user "wanderly"');
      },
    });
    const { conversation, cookie } = await newConversation(server);

    const response = await postMessage(server, conversation.id, cookie);

    const { events } = parseSse(response.body);
    expect(events.map((event) => event.event)).toEqual(['run.started', 'error']);
    expect(events[1]?.data).toMatchObject({
      type: 'error',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side. Please try again.',
      },
    });
    expect(response.body).not.toContain('password');
    const failure = log.entries().find((entry) => entry['msg'] === 'agent run failed');
    expect(JSON.stringify(failure)).toContain('password authentication failed');
  });

  it('replaces an event that breaks the contract with an internal error event', async () => {
    const log = memoryLog();
    const { server } = await start({
      log,
      runAgent: async (input, deps) => {
        deps.onEvent({
          type: 'tool.finished',
          call: { callId: '', name: 'x', input: {}, ok: true, durationMs: -1, summary: '' },
        });
        return okResult(input);
      },
    });
    const { conversation, cookie } = await newConversation(server);

    const { events } = parseSse((await postMessage(server, conversation.id, cookie)).body);

    expect(events.map((event) => event.event)).toEqual([
      'run.started',
      'error',
      'response',
      'run.finished',
    ]);
    expect(events[1]?.data).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(log.entries().some((entry) => entry['msg'] === 'invalid SSE event dropped')).toBe(true);
  });

  it('sends heartbeat comments while the run is quiet', async () => {
    const { server } = await start({
      heartbeatMs: 5,
      runAgent: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return okResult(input);
      },
    });
    const { conversation, cookie } = await newConversation(server);

    const { comments } = parseSse((await postMessage(server, conversation.id, cookie)).body);

    expect(comments.length).toBeGreaterThan(0);
    expect(comments.every((comment) => comment === ': keep-alive')).toBe(true);
  });

  it('refuses a message when the daily budget is spent, before any LLM call, as JSON', async () => {
    const runAgent = scriptedRunAgent();
    const { server } = await start({ runAgent, dailyBudgetUsd: 0 });
    const { conversation, cookie } = await newConversation(server);

    const response = await postMessage(server, conversation.id, cookie);

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({
      error: {
        code: 'BUDGET_EXCEEDED',
        message: "The demo's daily budget is used up. Please come back tomorrow.",
      },
    });
    expect(runAgent.calls).toEqual([]);
  });

  it('refuses a turn beyond the conversation limit with a clear 409', async () => {
    const { server } = await start({ maxUserTurns: 1 });
    const { conversation, cookie } = await newConversation(server);
    await postMessage(server, conversation.id, cookie);

    const response = await postMessage(server, conversation.id, cookie);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'This conversation has reached its limit of 1 messages. Please start a new conversation.',
      },
    });
  });

  it('refuses a second message while a reply is being written', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server } = await start({
      runAgent: async (input) => {
        await gate;
        return okResult(input);
      },
    });
    const { conversation, cookie } = await newConversation(server);

    const first = postMessage(server, conversation.id, cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await postMessage(server, conversation.id, cookie);
    release();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('still being written') },
    });
    expect((await first).statusCode).toBe(200);
  });

  it('aborts the run when the client disconnects and records it as cancelled', async () => {
    const aborted = vi.fn();
    const llm = fakeLlm(
      (_request, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted();
            reject(new Error('aborted'));
          });
        }),
    );
    const log = memoryLog();
    const { server, store } = await start({
      llm,
      log,
      runAgent: async (input, deps) => {
        await deps.llm.generate(
          { system: '', tools: [], messages: [], maxTokens: 10 },
          { signal: new AbortController().signal },
        );
        return okResult(input);
      },
    });
    const { conversation, cookie } = await newConversation(server);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/conversations/${conversation.id}/messages`,
          headers: { cookie, 'content-type': 'application/json' },
        },
        (response) => {
          response.once('data', (chunk: Buffer) => {
            expect(chunk.toString()).toContain('event: run.started');
            request.destroy();
            resolve();
          });
        },
      );
      request.on('error', (error) => {
        if (!('code' in error) || error.code !== 'ECONNRESET') reject(error);
      });
      request.end(JSON.stringify({ text: 'Sicily in May?' }));
    });

    await vi.waitFor(() => expect(store.runs[0]?.errorCode).toBe('CANCELLED'));
    expect(aborted).toHaveBeenCalledOnce();
    expect(store.messages).toEqual([]);
    await vi.waitFor(() =>
      expect(
        log.entries().find((entry) => entry['msg'] === 'agent run cancelled by the client'),
      ).toMatchObject({ level: 30 }),
    );
  });
});

describe('rate limiting', () => {
  it('limits the message route per IP with the error envelope and Retry-After', async () => {
    const { server } = await start({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' } });
    const { conversation, cookie } = await newConversation(server);

    const statuses: number[] = [];
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await postMessage(server, conversation.id, cookie, `message ${attempt}`);
      statuses.push(last.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.headers['retry-after']).toBe('60');
    expect(last?.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry in 1 minute.' },
    });
    const list = await server.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
  });

  it('applies the looser API limit to the other routes', async () => {
    const { server } = await start({
      env: { API_RATE_LIMIT_MAX: '2', API_RATE_LIMIT_WINDOW_MS: '1000' },
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await server.inject({ method: 'GET', url: '/api/conversations' })).statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe('POST /api/runs/:id/feedback', () => {
  it('stores the rating of a run of the session and scores its trace', async () => {
    const { server, store, tracer } = await start();
    const { conversation, cookie } = await newConversation(server);
    await postMessage(server, conversation.id, cookie);
    const runId = store.runs[0]?.id ?? '';

    const response = await server.inject({
      method: 'POST',
      url: `/api/runs/${runId}/feedback`,
      headers: { cookie },
      payload: { rating: 1, comment: '  Lovely plan  ' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(store.feedback.get(runId)).toMatchObject({ rating: 1, comment: 'Lovely plan' });
    expect(tracer.traceScores).toEqual([
      { traceId: 'trace-xyz', name: 'user_feedback', value: 1, comment: 'Lovely plan' },
    ]);
  });
});
