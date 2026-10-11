import { tracing } from '@opentelemetry/sdk-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmUsage } from '../../domain/ports/llm.js';
import {
  TRACE_NAME,
  createLangfuseTracer,
  startLangfuseTracing,
  usageDetails,
  type LangfuseTracing,
  type ScoreSink,
} from './langfuse-tracer.js';

type ReadableSpan = tracing.ReadableSpan;

const USAGE: LlmUsage = {
  inputTokens: 1_200,
  outputTokens: 340,
  cacheReadTokens: 4_000,
  cacheWriteTokens: 0,
};

const START = {
  runId: 'run-1',
  conversationId: 'conversation-1',
  model: 'claude-haiku-5-5',
  promptVersion: 'agent-v1-0123456789ab',
  userText: 'Sicily in May?',
  tags: ['api'],
};

function fakeScores(): ScoreSink & {
  created: Array<Parameters<ScoreSink['create']>[0]>;
  shutdown: () => Promise<void>;
} {
  const created: Array<Parameters<ScoreSink['create']>[0]> = [];
  return {
    created,
    create: (score) => {
      created.push(score);
    },
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
}

let running: LangfuseTracing | undefined;

afterEach(async () => {
  await running?.shutdown();
  running = undefined;
});

function start(onError = vi.fn()) {
  const exporter = new tracing.InMemorySpanExporter();
  const scores = fakeScores();
  running = startLangfuseTracing({
    publicKey: 'pk-lf-test',
    secretKey: 'sk-lf-test',
    baseUrl: 'http://127.0.0.1:9',
    environment: 'test',
    exporter,
    scores,
    onError,
  });
  return { tracer: running.tracer, exporter, scores, onError };
}

const attr = (span: ReadableSpan | undefined, key: string) => span?.attributes[key];
const json = (span: ReadableSpan | undefined, key: string): unknown => {
  const value = attr(span, key);
  return typeof value === 'string' ? JSON.parse(value) : undefined;
};
const millis = (span: ReadableSpan | undefined) =>
  span === undefined ? [] : [span.startTime, span.endTime].map(([s, ns]) => s * 1_000 + ns / 1e6);

async function recordRun() {
  const context = start();
  const trace = context.tracer.startRun(START);
  trace.llmCall({
    step: 1,
    model: 'claude-haiku-5-5',
    startedAt: new Date('2026-10-10T09:00:00.000Z'),
    endedAt: new Date('2026-10-10T09:00:02.500Z'),
    usage: USAGE,
    costUsd: 0.00033,
    stopReason: 'tool_use',
    input: [{ role: 'user', content: 'Sicily in May?' }],
    output: [{ type: 'tool_call', name: 'search_knowledge' }],
    error: null,
  });
  trace.toolCall({
    step: 1,
    callId: 'call-1',
    name: 'search_knowledge',
    startedAt: new Date('2026-10-10T09:00:02.600Z'),
    endedAt: new Date('2026-10-10T09:00:02.700Z'),
    input: { query: 'Sicily May weather' },
    output: { chunks: 3 },
    ok: true,
    error: null,
  });
  trace.toolCall({
    step: 1,
    callId: 'call-2',
    name: 'get_seasonal_weather',
    startedAt: new Date('2026-10-10T09:00:02.600Z'),
    endedAt: new Date('2026-10-10T09:00:07.600Z'),
    input: { destinationId: 'sicily', month: 5 },
    output: null,
    ok: false,
    error: 'timed out after 5000 ms',
  });
  trace.score('citations_ok', 1);
  trace.score('tool_errors', 1, 'one tool timed out');
  trace.end({
    status: 'ok',
    responseType: 'answer',
    errorCode: null,
    output: { type: 'answer', message: 'Yes.' },
    usage: USAGE,
    costUsd: 0.00033,
    steps: 1,
  });
  await context.tracer.flush();
  const spans = context.exporter.getFinishedSpans();
  return {
    ...context,
    trace,
    root: spans.find((span) => span.name === TRACE_NAME),
    generation: spans.find((span) => span.name === 'llm-call-1'),
    tool: spans.find((span) => span.name === 'search_knowledge'),
    failedTool: spans.find((span) => span.name === 'get_seasonal_weather'),
    spans,
  };
}

describe('Langfuse tracer mapping', () => {
  it('creates one trace per run, named and grouped by conversation', async () => {
    const { trace, root, spans } = await recordRun();

    expect(spans).toHaveLength(4);
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans.every((span) => span.spanContext().traceId === trace.traceId)).toBe(true);
    expect(attr(root, 'langfuse.observation.type')).toBe('agent');
    expect(json(root, 'langfuse.observation.input')).toEqual({ userText: 'Sicily in May?' });
    expect(json(root, 'langfuse.observation.output')).toEqual({ type: 'answer', message: 'Yes.' });
    expect(attr(root, 'langfuse.environment')).toBe('test');
    for (const span of spans) {
      expect(attr(span, 'langfuse.trace.name')).toBe(TRACE_NAME);
      expect(attr(span, 'session.id')).toBe('conversation-1');
      expect(attr(span, 'langfuse.trace.tags')).toEqual(['api']);
      expect(attr(span, 'langfuse.version')).toBe('agent-v1-0123456789ab');
    }
    expect(attr(root, 'langfuse.observation.metadata.runId')).toBe('run-1');
    expect(attr(root, 'langfuse.observation.metadata.promptVersion')).toBe('agent-v1-0123456789ab');
    expect(attr(root, 'langfuse.observation.metadata.status')).toBe('ok');
  });

  it('records each LLM call as a generation with our usage, cost and exact timings', async () => {
    const { root, generation } = await recordRun();

    expect(generation?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(attr(generation, 'langfuse.observation.type')).toBe('generation');
    expect(attr(generation, 'langfuse.observation.model.name')).toBe('claude-haiku-5-5');
    expect(json(generation, 'langfuse.observation.usage_details')).toEqual({
      input: 1_200,
      output: 340,
      cache_read_input_tokens: 4_000,
      cache_creation_input_tokens: 0,
    });
    expect(json(generation, 'langfuse.observation.cost_details')).toEqual({ total: 0.00033 });
    expect(millis(generation)).toEqual([
      Date.parse('2026-10-10T09:00:00.000Z'),
      Date.parse('2026-10-10T09:00:02.500Z'),
    ]);
    expect(attr(generation, 'langfuse.observation.level')).toBeUndefined();
  });

  it('records each tool call as a tool observation, at ERROR level when it failed', async () => {
    const { root, tool, failedTool } = await recordRun();

    expect(tool?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(attr(tool, 'langfuse.observation.type')).toBe('tool');
    expect(attr(tool, 'langfuse.observation.level')).toBe('DEFAULT');
    expect(json(tool, 'langfuse.observation.input')).toEqual({ query: 'Sicily May weather' });
    expect(attr(tool, 'langfuse.observation.metadata.callId')).toBe('call-1');
    expect(attr(failedTool, 'langfuse.observation.level')).toBe('ERROR');
    expect(attr(failedTool, 'langfuse.observation.status_message')).toBe('timed out after 5000 ms');
    expect(millis(failedTool)).toEqual([
      Date.parse('2026-10-10T09:00:02.600Z'),
      Date.parse('2026-10-10T09:00:07.600Z'),
    ]);
  });

  it('attaches scores to the trace', async () => {
    const { trace, scores } = await recordRun();

    expect(scores.created).toEqual([
      { traceId: trace.traceId, name: 'citations_ok', value: 1 },
      { traceId: trace.traceId, name: 'tool_errors', value: 1, comment: 'one tool timed out' },
    ]);
    expect(scores.flush).toHaveBeenCalled();
  });

  it('marks a failed run and its failed LLM call as errors', async () => {
    const { tracer, exporter } = start();
    const trace = tracer.startRun(START);
    trace.llmCall({
      step: 1,
      model: 'claude-haiku-5-5',
      startedAt: new Date('2026-10-10T09:00:00.000Z'),
      endedAt: new Date('2026-10-10T09:00:45.000Z'),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      stopReason: null,
      input: [],
      output: null,
      error: 'LLM call timed out after 45000 ms',
    });
    trace.end({
      status: 'error',
      responseType: null,
      errorCode: 'LLM_TIMEOUT',
      output: { error: 'LLM_TIMEOUT' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      steps: 1,
    });
    await tracer.flush();

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === TRACE_NAME);
    const generation = spans.find((span) => span.name === 'llm-call-1');
    expect(attr(root, 'langfuse.observation.level')).toBe('ERROR');
    expect(attr(root, 'langfuse.observation.status_message')).toBe('LLM_TIMEOUT');
    expect(attr(generation, 'langfuse.observation.level')).toBe('ERROR');
    expect(attr(generation, 'langfuse.observation.status_message')).toBe(
      'LLM call timed out after 45000 ms',
    );
  });

  it('scores a past trace (user feedback)', () => {
    const { tracer, scores } = start();

    tracer.scoreTrace('abc123', 'user_feedback', -1, 'Too packed');
    tracer.scoreTrace('abc123', 'user_feedback', 1);

    expect(scores.created).toEqual([
      { traceId: 'abc123', name: 'user_feedback', value: -1, comment: 'Too packed' },
      { traceId: 'abc123', name: 'user_feedback', value: 1 },
    ]);
  });

  it('flushes and releases the score client on shutdown', async () => {
    const { scores } = start();
    const current = running;
    running = undefined;

    await current?.shutdown();

    expect(scores.flush).toHaveBeenCalled();
    expect(scores.shutdown).toHaveBeenCalled();
  });
});

describe('Langfuse tracer resilience', () => {
  it('never lets a tracing failure reach the caller', async () => {
    const onError = vi.fn();
    const scores: ScoreSink = {
      create: () => {
        throw new Error('queue full');
      },
      flush: () => Promise.reject(new Error('network down')),
    };
    const tracer = createLangfuseTracer({
      scores,
      flushSpans: () => Promise.reject(new Error('exporter down')),
      onError,
    });

    const trace = tracer.startRun(START);
    expect(() => trace.score('citations_ok', 1)).not.toThrow();
    expect(() => tracer.scoreTrace('t', 'user_feedback', 1)).not.toThrow();
    await expect(tracer.flush()).resolves.toBeUndefined();

    expect(onError.mock.calls.map(([, operation]) => operation)).toEqual([
      'score',
      'scoreTrace',
      'flush',
      'flush',
    ]);
  });

  it('reports bad records instead of throwing', () => {
    const { tracer, onError } = start();
    const trace = tracer.startRun(START);

    trace.llmCall(null as never);
    trace.toolCall(null as never);
    trace.end(null as never);

    expect(onError.mock.calls.map(([, operation]) => operation)).toEqual([
      'llmCall',
      'toolCall',
      'end',
    ]);
  });

  it('works without an error handler', () => {
    const tracer = createLangfuseTracer({
      scores: {
        create: () => {
          throw new Error('boom');
        },
        flush: async () => undefined,
      },
      flushSpans: async () => undefined,
    });
    expect(() => tracer.scoreTrace('t', 'user_feedback', 1)).not.toThrow();
  });
});

describe('usageDetails', () => {
  it("uses Langfuse's keys for Anthropic token counts", () => {
    expect(usageDetails(USAGE)).toEqual({
      input: 1_200,
      output: 340,
      cache_read_input_tokens: 4_000,
      cache_creation_input_tokens: 0,
    });
  });
});
