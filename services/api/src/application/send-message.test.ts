import { AgentEventSchema, EMPTY_TRIP_BRIEF, type AgentEvent } from '@wanderly/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_KNOWLEDGE,
  FAKE_RETRIEVER,
  TEST_LIMITS,
  TEST_PRICING,
  errorResult,
  fakeLlm,
  llmResponse,
  okResult,
  scriptedRunAgent,
} from '../../test/agent-fakes.js';
import {
  ANSWER,
  InMemoryStore,
  SESSION_A,
  SESSION_B,
  SOURCES,
  exchange,
  manualClock,
  recordingTracer,
  sequentialIds,
} from '../../test/application-fakes.js';
import {
  BudgetExceededError,
  InvalidOutputError,
  LlmTimeoutError,
  NotFoundError,
} from '../domain/errors.js';
import type { LlmPort } from '../domain/ports/llm.js';
import { ConversationBusyError, TurnLimitReachedError } from './errors.js';
import type { RunAgent } from './ports/agent-runner.js';
import type { UseCaseLogger } from './ports/system.js';
import {
  MAX_USER_TURNS,
  TRACE_SCORES,
  createSendMessage,
  type SendMessageDeps,
} from './send-message.js';

const CONVERSATION_ID = 'c0000000-0000-4000-8000-000000000001';
const CANARY = 'canary-0123456789abcdef';

let store: InMemoryStore;
let clock: ReturnType<typeof manualClock>;
let ids: ReturnType<typeof sequentialIds>;
let tracer: ReturnType<typeof recordingTracer>;

beforeEach(async () => {
  store = new InMemoryStore();
  clock = manualClock('2026-10-10T09:00:00.000Z');
  ids = sequentialIds();
  tracer = recordingTracer('trace-abc');
  await store.conversationRepository.create({
    id: CONVERSATION_ID,
    sessionId: SESSION_A,
    brief: EMPTY_TRIP_BRIEF,
    now: new Date('2026-10-10T08:00:00.000Z'),
  });
});

function sendMessage(
  runAgent: RunAgent,
  overrides: Partial<SendMessageDeps> & { llm?: LlmPort } = {},
) {
  const { llm = fakeLlm(), ...rest } = overrides;
  return createSendMessage({
    conversations: store.conversationRepository,
    runs: store.runRepository,
    unitOfWork: store.unitOfWork,
    ledger: store.ledger,
    agent: {
      runAgent,
      llm,
      retriever: FAKE_RETRIEVER,
      knowledge: FAKE_KNOWLEDGE,
      limits: TEST_LIMITS,
      pricing: TEST_PRICING,
      canaryToken: CANARY,
      promptVersion: 'agent-v1-test',
    },
    tracer,
    clock,
    ids,
    dailyBudgetUsd: 2,
    traceTags: ['api'],
    ...rest,
  });
}

function io(controller = new AbortController(), log?: UseCaseLogger) {
  const events: AgentEvent[] = [];
  return {
    events,
    signal: controller.signal,
    emit: (event: AgentEvent) => {
      events.push(AgentEventSchema.parse(event));
    },
    ...(log === undefined ? {} : { log }),
  };
}

const command = (text = 'Sicily in May?', sessionId = SESSION_A) => ({
  sessionId,
  conversationId: CONVERSATION_ID,
  text,
});

describe('SendMessage — a completed turn', () => {
  it('streams the run events in order and returns the assistant message', async () => {
    const runAgent = scriptedRunAgent((input) => {
      clock.advance(1_500);
      return okResult(input);
    });
    const sink = io();

    const result = await sendMessage(runAgent).execute(command(), sink);

    expect(sink.events.map((event) => event.type)).toEqual([
      'run.started',
      'tool.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
      'response',
      'run.finished',
    ]);
    const [runId, userMessageId] = ids.issued;
    expect(sink.events[0]).toEqual({
      type: 'run.started',
      runId,
      conversationId: CONVERSATION_ID,
      userMessageId,
    });
    expect(sink.events.every((event) => 'runId' in event && event.runId === runId)).toBe(true);
    expect(sink.events.at(-1)).toEqual({
      type: 'run.finished',
      runId,
      steps: 2,
      usage: { inputTokens: 3_000, outputTokens: 600, cacheReadTokens: 1_500, cacheWriteTokens: 0 },
      costUsd: 0.000615,
      latencyMs: 1_234,
      traceId: 'trace-abc',
    });
    expect(result.message).toMatchObject({
      role: 'assistant',
      runId,
      response: ANSWER,
      sources: SOURCES,
      createdAt: '2026-10-10T09:00:01.500Z',
    });
    expect(sink.events[5]).toEqual({ type: 'response', runId, message: result.message });
  });

  it('hands the agent the stored history, the brief, the date and the run configuration', async () => {
    const runAgent = scriptedRunAgent();
    const send = sendMessage(runAgent);
    await send.execute(command('First question'), io());

    await send.execute(command('Second question'), io());

    const second = runAgent.calls[1];
    expect(second?.input).toMatchObject({
      conversationId: CONVERSATION_ID,
      userText: 'Second question',
      brief: ANSWER.brief,
      today: '2026-10-10',
      history: exchange('First question'),
    });
    expect(second?.deps).toMatchObject({
      limits: TEST_LIMITS,
      pricing: TEST_PRICING,
      clock,
      canaryToken: CANARY,
    });
    expect(second?.deps.signal).toBeInstanceOf(AbortSignal);
    expect(second?.deps.trace.traceId).toBe('trace-abc');
  });

  it('appends the new messages after the history with the announced user message id', async () => {
    const send = sendMessage(scriptedRunAgent());
    await send.execute(command('First question'), io());
    const sink = io();

    await send.execute(command('Second question'), sink);

    const stored = store.messagesOf(CONVERSATION_ID);
    expect(stored.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(stored.slice(4).map((message) => message.message)).toEqual(exchange('Second question'));
    const started = sink.events[0];
    if (started?.type !== 'run.started') throw new Error('expected run.started first');
    expect(stored[4]?.id).toBe(started.userMessageId);
    expect(stored[4]).toMatchObject({ provider: null, model: null });
    expect(stored[5]).toMatchObject({ provider: 'fake', model: 'fake-model' });
  });

  it('records the run with its accounting, online checks and display payload', async () => {
    const result = await sendMessage(scriptedRunAgent()).execute(command(), io());

    const stored = store.messagesOf(CONVERSATION_ID);
    expect(store.runs).toEqual([
      expect.objectContaining({
        id: result.runId,
        conversationId: CONVERSATION_ID,
        traceId: 'trace-abc',
        model: 'fake-model',
        promptVersion: 'agent-v1-test',
        status: 'ok',
        responseType: 'answer',
        errorCode: null,
        steps: 2,
        repairs: 0,
        toolCallCount: 2,
        toolErrorCount: 1,
        costUsd: 0.000615,
        latencyMs: 1_234,
        validFirstTry: true,
        citationsOk: true,
        userText: 'Sicily in May?',
        userMessageId: stored[0]?.id,
        assistantMessageId: stored[3]?.id,
        response: ANSWER,
        sources: SOURCES,
      }),
    ]);
    expect(result.message.id).toBe(stored[3]?.id);
  });

  it('updates the brief and titles the conversation after its first message only', async () => {
    const send = sendMessage(scriptedRunAgent());
    clock.set('2026-10-10T10:00:00.000Z');
    await send.execute(command('  A week in   Sicily\nin May, hiking please  '), io());
    await send.execute(command('Something else entirely'), io());

    expect(store.conversations.get(CONVERSATION_ID)).toMatchObject({
      title: 'A week in Sicily in May, hiking please',
      brief: ANSWER.brief,
      updatedAt: new Date('2026-10-10T10:00:00.000Z'),
    });
  });

  it('scores the trace online and ends it with the outcome', async () => {
    await sendMessage(scriptedRunAgent()).execute(command(), io());

    const [trace] = tracer.traces;
    expect(trace?.start).toEqual({
      runId: ids.issued[0],
      conversationId: CONVERSATION_ID,
      model: 'fake-model',
      promptVersion: 'agent-v1-test',
      userText: 'Sicily in May?',
      tags: ['api'],
    });
    expect(trace?.scores).toEqual([
      { name: TRACE_SCORES.validFirstTry, value: 1, comment: undefined },
      { name: TRACE_SCORES.citationsOk, value: 1, comment: undefined },
      { name: TRACE_SCORES.toolErrors, value: 1, comment: undefined },
    ]);
    expect(trace?.end).toMatchObject({
      status: 'ok',
      responseType: 'answer',
      errorCode: null,
      output: ANSWER,
      costUsd: 0.000615,
      steps: 2,
    });
  });

  it('flags citations that do not resolve to a shown source', async () => {
    const runAgent = scriptedRunAgent((input) =>
      okResult(input, { sources: [], validFirstTry: false, repairs: 1 }),
    );

    await sendMessage(runAgent).execute(command(), io());

    expect(store.runs[0]).toMatchObject({ citationsOk: false, validFirstTry: false, repairs: 1 });
    expect(tracer.traces[0]?.scores.slice(0, 2)).toEqual([
      { name: TRACE_SCORES.validFirstTry, value: 0, comment: undefined },
      { name: TRACE_SCORES.citationsOk, value: 0, comment: undefined },
    ]);
  });

  it('uses the run id as the assistant message id when the run appended no assistant message', async () => {
    const runAgent = scriptedRunAgent((input) =>
      okResult(input, {
        newMessages: [{ role: 'user', content: [{ type: 'text', text: input.userText }] }],
      }),
    );

    const result = await sendMessage(runAgent).execute(command(), io());

    expect(result.message.id).toBe(result.runId);
    expect(store.runs[0]?.assistantMessageId).toBeNull();
  });

  it('logs the guardrail signals of the run', async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const runAgent = scriptedRunAgent((input) =>
      okResult(input, {
        signals: {
          canaryLeak: true,
          providerRefusal: true,
          injectionSignals: ['ignore-previous-instructions'],
        },
      }),
    );

    await sendMessage(runAgent).execute(command(), io(new AbortController(), log));

    const runId = ids.issued[0];
    expect(log.error).toHaveBeenCalledWith(
      { runId },
      'system prompt canary found in a model output',
    );
    expect(log.warn).toHaveBeenCalledWith({ runId }, 'the provider refused to answer');
    expect(log.warn).toHaveBeenCalledWith(
      { runId, injectionSignals: ['ignore-previous-instructions'] },
      'prompt injection signals',
    );
  });

  it('logs nothing for a run without signals', async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    await sendMessage(scriptedRunAgent()).execute(command(), io(new AbortController(), log));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps going when the event sink throws, and logs it', async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const sink = {
      signal: new AbortController().signal,
      emit: () => {
        throw new Error('socket closed');
      },
      log,
    };

    const result = await sendMessage(scriptedRunAgent()).execute(command(), sink);

    expect(result.runId).toBe(ids.issued[0]);
    expect(store.runs).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'run.started' }),
      'failed to emit a run event',
    );
  });
});

describe('SendMessage — pre-flight checks', () => {
  it('answers NotFound for a conversation of another session, before any event', async () => {
    const runAgent = scriptedRunAgent();
    const sink = io();

    await expect(
      sendMessage(runAgent).execute(command('hi', SESSION_B), sink),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(sink.events).toEqual([]);
    expect(runAgent.calls).toEqual([]);
  });

  it('marks the conversation active when a run starts, even if the run fails', async () => {
    clock.set('2026-10-10T09:30:00.000Z');
    const failing = scriptedRunAgent((input) =>
      errorResult(input, new LlmTimeoutError(45_000), 'llm_timeout'),
    );

    await expect(sendMessage(failing).execute(command(), io())).rejects.toBeInstanceOf(
      LlmTimeoutError,
    );

    expect(store.conversations.get(CONVERSATION_ID)?.updatedAt).toEqual(
      new Date('2026-10-10T09:30:00.000Z'),
    );
  });

  it('answers NotFound when the conversation was purged after it was loaded, before any LLM call', async () => {
    const runAgent = scriptedRunAgent();
    const conversations = {
      ...store.conversationRepository,
      markActive: async (id: string) => {
        store.conversations.delete(id);
        throw new NotFoundError('conversation', id);
      },
    };
    const sink = io();

    await expect(
      sendMessage(runAgent, { conversations }).execute(command(), sink),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(runAgent.calls).toEqual([]);
    expect(sink.events).toEqual([]);
    expect(store.runs).toEqual([]);
  });

  it(`refuses a turn beyond ${MAX_USER_TURNS} completed turns, before any LLM call`, async () => {
    const runAgent = scriptedRunAgent();
    const send = sendMessage(runAgent, { maxUserTurns: 2 });
    await send.execute(command('one'), io());
    await send.execute(command('two'), io());
    const sink = io();

    const attempt = send.execute(command('three'), sink);

    await expect(attempt).rejects.toBeInstanceOf(TurnLimitReachedError);
    await expect(attempt).rejects.toMatchObject({ limit: 2 });
    expect(runAgent.calls).toHaveLength(2);
    expect(sink.events).toEqual([]);
  });

  it('allows twelve turns by default', async () => {
    const send = sendMessage(scriptedRunAgent());
    for (let turn = 1; turn <= MAX_USER_TURNS; turn += 1) {
      await send.execute(command(`turn ${turn}`), io());
    }
    await expect(send.execute(command('one more'), io())).rejects.toBeInstanceOf(
      TurnLimitReachedError,
    );
  });

  it('does not count failed runs as turns', async () => {
    const failing = scriptedRunAgent((input) =>
      errorResult(input, new LlmTimeoutError(45_000), 'llm_timeout'),
    );
    const send = sendMessage(failing, { maxUserTurns: 1 });
    await expect(send.execute(command(), io())).rejects.toBeInstanceOf(LlmTimeoutError);

    await expect(send.execute(command(), io())).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(failing.calls).toHaveLength(2);
  });

  it('refuses to start when the daily budget cannot cover one more run, before any LLM call', async () => {
    const generate = vi.fn();
    const runAgent = scriptedRunAgent();
    store.ledger.extraSpentUsd = 1.96;
    const sink = io();

    const attempt = sendMessage(runAgent, { llm: fakeLlm(generate) }).execute(command(), sink);

    await expect(attempt).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(attempt).rejects.toMatchObject({ spentUsd: 1.96, limitUsd: 2 });
    expect(runAgent.calls).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(sink.events).toEqual([]);
    expect(store.runs).toEqual([]);
  });

  it("counts only today's (UTC) spending", async () => {
    clock.set('2026-10-09T23:59:00.000Z');
    const send = sendMessage(scriptedRunAgent((input) => okResult(input, { costUsd: 1.99 })));
    await send.execute(command(), io());
    await expect(send.execute(command(), io())).rejects.toBeInstanceOf(BudgetExceededError);

    clock.set('2026-10-10T00:00:00.000Z');
    await expect(send.execute(command(), io())).resolves.toMatchObject({ costUsd: 1.99 });
  });

  it('treats a zero budget as a kill switch', async () => {
    await expect(
      sendMessage(scriptedRunAgent(), { dailyBudgetUsd: 0 }).execute(command(), io()),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('runs one turn at a time per conversation', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = sendMessage(
      scriptedRunAgent(async (input) => {
        await gate;
        return okResult(input);
      }),
    );

    const first = send.execute(command('first'), io());
    await vi.waitFor(() => expect(tracer.traces).toHaveLength(1));
    await expect(send.execute(command('second'), io())).rejects.toBeInstanceOf(
      ConversationBusyError,
    );
    release();
    await first;

    await expect(send.execute(command('third'), io())).resolves.toBeDefined();
  });
});

describe('SendMessage — failed runs', () => {
  const failWith = (error: InvalidOutputError | LlmTimeoutError) =>
    scriptedRunAgent((input) =>
      errorResult(input, error, error.code === 'LLM_TIMEOUT' ? 'run_deadline' : 'invalid_output', {
        repairs: 1,
      }),
    );

  it('records the run, leaves the history untouched and throws the domain error', async () => {
    const error = new InvalidOutputError(['days: expected 3, got 2']);
    const sink = io();

    await expect(sendMessage(failWith(error)).execute(command(), sink)).rejects.toBe(error);

    expect(sink.events.map((event) => event.type)).toEqual([
      'run.started',
      'tool.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
    ]);
    expect(store.messages).toEqual([]);
    expect(store.conversations.get(CONVERSATION_ID)?.title).toBeNull();
    expect(store.runs).toEqual([
      expect.objectContaining({
        status: 'error',
        errorCode: 'INVALID_OUTPUT',
        failureReason: 'invalid_output',
        responseType: null,
        costUsd: 0.0004,
        repairs: 1,
        toolCallCount: 2,
        toolErrorCount: 1,
        validFirstTry: false,
        citationsOk: null,
        userText: 'Sicily in May?',
        userMessageId: null,
        response: null,
      }),
    ]);
    const [trace] = tracer.traces;
    expect(trace?.scores.map((score) => score.name)).toEqual([
      TRACE_SCORES.validFirstTry,
      TRACE_SCORES.toolErrors,
    ]);
    expect(trace?.end).toMatchObject({
      status: 'error',
      errorCode: 'INVALID_OUTPUT',
      output: { error: 'INVALID_OUTPUT' },
    });
  });

  it('leaves first-try validity unknown for errors outside output validation', async () => {
    await expect(
      sendMessage(failWith(new LlmTimeoutError(45_000))).execute(command(), io()),
    ).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(store.runs[0]).toMatchObject({
      errorCode: 'LLM_TIMEOUT',
      failureReason: 'run_deadline',
      validFirstTry: null,
    });
  });

  it('records a run abandoned by its client as CANCELLED', async () => {
    const controller = new AbortController();
    const runAgent = scriptedRunAgent((input) => {
      controller.abort();
      return errorResult(input, new LlmTimeoutError(45_000), 'llm_timeout');
    });

    await expect(sendMessage(runAgent).execute(command(), io(controller))).rejects.toBeInstanceOf(
      LlmTimeoutError,
    );
    expect(store.runs[0]).toMatchObject({
      status: 'error',
      errorCode: 'CANCELLED',
      failureReason: 'cancelled',
    });
  });

  it('cancels in-flight LLM calls when the client disconnects', async () => {
    const controller = new AbortController();
    const llm = fakeLlm(
      (_request, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by the caller')));
        }),
    );
    const runAgent: RunAgent = async (input, deps) => {
      setTimeout(() => controller.abort(), 0);
      await deps.llm.generate(
        { system: '', tools: [], messages: [], maxTokens: 10 },
        { signal: new AbortController().signal },
      );
      return okResult(input);
    };

    await expect(sendMessage(runAgent, { llm }).execute(command(), io(controller))).rejects.toThrow(
      'aborted by the caller',
    );
    expect(store.runs[0]).toMatchObject({ errorCode: 'CANCELLED', costUsd: 0 });
  });

  it('records the spend of a crashed run from the metered LLM calls, then rethrows', async () => {
    const llm = fakeLlm(async () => llmResponse());
    const bug = new TypeError('cannot read properties of undefined');
    const runAgent: RunAgent = async (_input, deps) => {
      await deps.llm.generate(
        { system: '', tools: [], messages: [], maxTokens: 10 },
        { signal: new AbortController().signal },
      );
      clock.advance(800);
      throw bug;
    };

    await expect(sendMessage(runAgent, { llm }).execute(command(), io())).rejects.toBe(bug);

    expect(store.runs).toEqual([
      expect.objectContaining({
        status: 'error',
        errorCode: 'INTERNAL_ERROR',
        failureReason: 'crash',
        usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: (1_000 * 0.1 + 200 * 0.5) / 1_000_000,
        latencyMs: 800,
      }),
    ]);
    expect(tracer.traces[0]?.end).toMatchObject({ status: 'error', errorCode: 'INTERNAL_ERROR' });
  });

  it('records a crash after the client left as CANCELLED', async () => {
    const controller = new AbortController();
    const runAgent: RunAgent = async () => {
      controller.abort();
      throw new Error('AbortError');
    };

    await expect(sendMessage(runAgent).execute(command(), io(controller))).rejects.toThrow(
      'AbortError',
    );
    expect(store.runs[0]?.errorCode).toBe('CANCELLED');
  });

  it('records the run as failed when the turn cannot be committed', async () => {
    const dbError = new Error('connection terminated');
    store.failNext.appendMessages = dbError;

    await expect(sendMessage(scriptedRunAgent()).execute(command(), io())).rejects.toBe(dbError);

    expect(store.messages).toEqual([]);
    expect(store.runs).toEqual([
      expect.objectContaining({
        status: 'error',
        errorCode: 'INTERNAL_ERROR',
        failureReason: 'persistence',
        costUsd: 0.000615,
        response: null,
        userMessageId: null,
      }),
    ]);
  });

  it('logs a failure to record a failed run without hiding the run error', async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const error = new LlmTimeoutError(45_000);
    store.failNext.saveRun = new Error('database down');

    await expect(
      sendMessage(failWith(error)).execute(command(), io(new AbortController(), log)),
    ).rejects.toBe(error);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: ids.issued[0], costUsd: 0.0004 }),
      'failed to record a failed run',
    );
  });
});
