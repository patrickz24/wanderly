import type { AgentEvent } from '@wanderly/contracts';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubFetch } from '../test/fetch';
import { assistantMessage, ids, runFinished } from '../test/factories';
import { controllableSseResponse, sseFrame, sseResponse } from '../test/streams';
import { ApiError } from './api';
import { decodeAgentEvent, streamAgentRun } from './agentStream';

const runStarted: AgentEvent = {
  type: 'run.started',
  runId: ids.run,
  conversationId: ids.conversation,
  userMessageId: ids.userMessage,
};
const toolStarted: AgentEvent = {
  type: 'tool.started',
  runId: ids.run,
  callId: 'toolu_1',
  name: 'get_seasonal_weather',
  input: { destinationId: 'sicily', month: 5 },
};
const responseEvent: AgentEvent = { type: 'response', runId: ids.run, message: assistantMessage() };

async function run(options: { signal?: AbortSignal; idleTimeoutMs?: number } = {}) {
  const received: AgentEvent[] = [];
  await streamAgentRun(ids.conversation, 'A week in Sicily', {
    signal: options.signal ?? new AbortController().signal,
    idleTimeoutMs: options.idleTimeoutMs,
    onEvent: (event) => received.push(event),
  });
  return received;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('decodeAgentEvent', () => {
  it('ignores event names the contract does not know', () => {
    expect(decodeAgentEvent({ event: 'run.progress', data: '{}', lastEventId: '' })).toBeNull();
    expect(decodeAgentEvent({ event: 'message', data: 'hello', lastEventId: '' })).toBeNull();
  });

  it('rejects a known event whose data is not JSON', () => {
    expect(() => decodeAgentEvent({ event: 'response', data: '{oops', lastEventId: '' })).toThrow(
      expect.objectContaining({ kind: 'invalid-response' }),
    );
  });

  it('rejects a known event that breaks its schema', () => {
    const data = JSON.stringify({ type: 'run.started', runId: 'not-a-uuid' });
    expect(() => decodeAgentEvent({ event: 'run.started', data, lastEventId: '' })).toThrow(
      expect.objectContaining({ kind: 'invalid-response' }),
    );
  });

  it('rejects an event whose name and payload type disagree', () => {
    const data = JSON.stringify(runStarted);
    expect(() => decodeAgentEvent({ event: 'run.finished', data, lastEventId: '' })).toThrow(
      expect.objectContaining({ kind: 'invalid-response' }),
    );
  });
});

describe('streamAgentRun', () => {
  it('posts the message and asks for an event stream', async () => {
    const fetchMock = stubFetch(async () => sseResponse([sseFrame(runFinished())]));

    await run();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/conversations/${ids.conversation}/messages`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"text":"A week in Sicily"}');
    const headers = new Headers(init?.headers);
    expect(headers.get('Accept')).toBe('text/event-stream');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('delivers validated events in order, skipping heartbeats and unknown events', async () => {
    const frames = [
      ': connected\n\n',
      sseFrame(runStarted),
      'event: run.progress\ndata: {"pct":10}\n\n',
      sseFrame(toolStarted),
      ': heartbeat\n\n',
      sseFrame(responseEvent),
      sseFrame(runFinished()),
    ].join('');
    // Deliver the whole stream in awkward 7-byte chunks.
    const bytes = new TextEncoder().encode(frames);
    const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) =>
      bytes.slice(i * 7, i * 7 + 7),
    );
    stubFetch(async () => sseResponse(chunks));

    const received = await run();

    expect(received.map((e) => e.type)).toEqual([
      'run.started',
      'tool.started',
      'response',
      'run.finished',
    ]);
    expect(received[2]).toEqual(responseEvent);
  });

  it('resolves on an error event and stops reading', async () => {
    const stream = controllableSseResponse();
    stubFetch(async () => stream.response);
    const errorEvent: AgentEvent = {
      type: 'error',
      runId: ids.run,
      error: { code: 'LLM_TIMEOUT', message: 'The assistant took too long.' },
    };

    const pending = run();
    stream.emit(runStarted);
    stream.emit(errorEvent);

    expect((await pending).map((e) => e.type)).toEqual(['run.started', 'error']);
    expect(stream.cancelled).toBe(true);
  });

  it('maps a refusal before the stream to an http error with Retry-After', async () => {
    stubFetch(async () => {
      const response = jsonResponse(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
        429,
      );
      response.headers.set('Retry-After', '42');
      return response;
    });

    const error = await failure(run());

    expect(error).toMatchObject({ kind: 'http', status: 429, code: 'RATE_LIMITED' });
    expect(error.retryAfterMs).toBe(42_000);
  });

  it('rejects a 200 response that is not an event stream', async () => {
    stubFetch(async () => jsonResponse({ ok: true }));

    expect(await failure(run())).toMatchObject({ kind: 'invalid-response' });
  });

  it('rejects when a known event breaks the contract', async () => {
    stubFetch(async () =>
      sseResponse([sseFrame(runStarted), 'event: response\ndata: {"type":"response"}\n\n']),
    );

    expect(await failure(run())).toMatchObject({ kind: 'invalid-response' });
  });

  it('reports a network error when the stream ends before a terminal event', async () => {
    stubFetch(async () => sseResponse([sseFrame(runStarted), sseFrame(responseEvent)]));

    expect(await failure(run())).toMatchObject({ kind: 'network' });
  });

  it('reports a network error when fetch itself fails', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    expect(await failure(run())).toMatchObject({ kind: 'network' });
  });

  it('cancels the stream and reports "aborted" when the caller aborts', async () => {
    const stream = controllableSseResponse();
    stubFetch(async () => stream.response);
    const controller = new AbortController();
    const received: AgentEvent[] = [];

    const pending = streamAgentRun(ids.conversation, 'hi', {
      signal: controller.signal,
      onEvent: (event) => received.push(event),
    });
    stream.emit(runStarted);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    controller.abort();

    expect(await failure(pending)).toMatchObject({ kind: 'aborted' });
    expect(stream.cancelled).toBe(true);
  });

  it('does not call the API when the signal is already aborted', async () => {
    const fetchMock = stubFetch(async () => sseResponse([]));

    expect(await failure(run({ signal: AbortSignal.abort() }))).toMatchObject({
      kind: 'aborted',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out when the stream stays silent, but heartbeats keep it alive', async () => {
    const stream = controllableSseResponse();
    stubFetch(async () => stream.response);

    const pending = run({ idleTimeoutMs: 80 });
    // Heartbeats every 30 ms for ~150 ms: longer than the idle timeout in total.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      stream.push(': heartbeat\n\n');
    }
    expect(stream.cancelled).toBe(false);

    expect(await failure(pending)).toMatchObject({ kind: 'timeout' });
    expect(stream.cancelled).toBe(true);
  });
});
