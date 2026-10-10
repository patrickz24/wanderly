import { describe, expect, it } from 'vitest';
import { FakeLlm, reply, text, thinking, toolCall } from '../../../test/support/fake-llm.js';
import { runInput, testDeps } from '../../../test/support/agent-fakes.js';
import {
  clarificationStep,
  gatherStep,
  presentStep,
} from '../../../test/support/agent-scenarios.js';
import { LlmTimeoutError, ProviderUnavailableError } from '../errors.js';
import type { LlmCallOptions, LlmMessage } from '../ports/llm.js';
import { runAgent } from './run-agent.js';

const searchStep = (id: string) =>
  reply([
    toolCall(id, 'search_knowledge', { query: 'hiking trails', destinationId: null, limit: 1 }),
  ]);

describe('runAgent: model failures', () => {
  it('stops with LLM_TIMEOUT when one call exceeds its deadline, aborting the call', async () => {
    let seen: LlmCallOptions | undefined;
    const llm = new FakeLlm([
      (_request, options) => {
        seen = options;
        return new Promise(() => undefined);
      },
    ]);
    const deps = testDeps(llm, { limits: { llmTimeoutMs: 20 } });

    const result = await runAgent(runInput(), deps);

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('llm_timeout');
    expect(result.error).toBeInstanceOf(LlmTimeoutError);
    expect(result.error.details).toEqual({ timeoutMs: 20 });
    expect(seen?.signal.aborted).toBe(true);
    expect(result.steps).toBe(1);
    expect(deps.trace.llmCalls[0]?.error).toContain('DeadlineExceeded');
  });

  it('stops with LLM_TIMEOUT when the whole run exceeds its deadline', async () => {
    const llm = new FakeLlm([
      { delayMs: 5, then: searchStep('k1') },
      { delayMs: 1_000, then: clarificationStep() },
    ]);
    const result = await runAgent(
      runInput(),
      testDeps(llm, { limits: { runDeadlineMs: 40, llmTimeoutMs: 1_000 } }),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('run_deadline');
    expect(result.error.details).toEqual({ timeoutMs: 40 });
  });

  it('maps an adapter timeout to LLM_TIMEOUT', async () => {
    const llm = new FakeLlm([{ throws: new LlmTimeoutError(45_000) }]);
    const result = await runAgent(runInput(), testDeps(llm));
    expect(result.status === 'error' && result.reason).toBe('llm_timeout');
  });

  it('stops with PROVIDER_UNAVAILABLE and keeps the error', async () => {
    const unavailable = new ProviderUnavailableError('anthropic', { status: 529 });
    const llm = new FakeLlm([searchStep('k1'), { throws: unavailable }]);
    const result = await runAgent(runInput(), testDeps(llm));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('provider_unavailable');
    expect(result.error).toBe(unavailable);
    // What was spent before the failure is still reported.
    expect(result.steps).toBe(2);
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.newMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('rethrows unexpected errors (bugs, rejected requests)', async () => {
    const llm = new FakeLlm([{ throws: new TypeError('400 invalid_request_error') }]);
    await expect(runAgent(runInput(), testDeps(llm))).rejects.toThrow(TypeError);
  });

  it('answers a provider refusal with a decline and keeps the refused output out of history', async () => {
    const llm = new FakeLlm([reply([text('I cannot')], { stopReason: 'refusal' })]);
    const input = runInput();
    const result = await runAgent(input, testDeps(llm));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.response).toMatchObject({
      type: 'decline',
      reason: 'unsafe',
      brief: input.brief,
    });
    expect(result.signals.providerRefusal).toBe(true);
    expect(result.newMessages).toHaveLength(1);
  });

  it('fails as truncated at max_tokens without running the cut-off tool call', async () => {
    const llm = new FakeLlm([
      reply([toolCall('k1', 'search_knowledge', { query: 'hik' })], { stopReason: 'max_tokens' }),
    ]);
    const deps = testDeps(llm);
    const result = await runAgent(runInput(), deps);

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('truncated');
    expect(result.error.code).toBe('INVALID_OUTPUT');
    expect(deps.retriever.queries).toHaveLength(0);
    expect(result.newMessages).toHaveLength(1);
  });
});

describe('runAgent: limits', () => {
  it('stops at the step limit', async () => {
    const llm = new FakeLlm([searchStep('k1'), searchStep('k2'), searchStep('k3')]);
    const result = await runAgent(runInput(), testDeps(llm, { limits: { maxSteps: 2 } }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('step_limit');
    expect(result.steps).toBe(2);
    expect(llm.remaining).toBe(1);
    // The last tool results were delivered, so nothing is left open.
    expect(result.newMessages.at(-1)?.role).toBe('user');
  });

  it('refuses the first call when its worst-case cost exceeds the ceiling', async () => {
    const llm = new FakeLlm([clarificationStep()]);
    const result = await runAgent(runInput(), testDeps(llm, { limits: { maxRunCostUsd: 0.0001 } }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('cost_ceiling');
    expect(result.steps).toBe(0);
    expect(llm.requests).toHaveLength(0);
    expect(result.error.code).toBe('INVALID_OUTPUT');
  });

  it('stops before a call that could cross the ceiling, given what was already spent', async () => {
    const expensive = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const llm = new FakeLlm([
      reply(
        [toolCall('k1', 'search_knowledge', { query: 'hiking', destinationId: null, limit: 1 })],
        {
          usage: expensive,
        },
      ),
      clarificationStep(),
    ]);
    const result = await runAgent(
      runInput(),
      testDeps(llm, { limits: { maxRunCostUsd: 0.1001, maxOutputTokens: 1_000 } }),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('cost_ceiling');
    expect(result.steps).toBe(1);
    expect(result.costUsd).toBeCloseTo(0.1, 10);
  });
});

describe('runAgent: append-only history', () => {
  function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  const history: LlmMessage[] = deepFreeze([
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    {
      role: 'assistant',
      content: [
        thinking('sig-old'),
        { type: 'opaque', provider: 'other-provider', data: { kind: 'reasoning', blob: 'xyz' } },
        { type: 'tool_call', id: 'c0', name: 'ask_clarification', input: { message: 'Where?' } },
      ],
    },
  ]);

  it('never mutates the input history and replays opaque blocks verbatim', async () => {
    const before = structuredClone(history);
    const llm = new FakeLlm([gatherStep('sig-new'), presentStep()]);

    const result = await runAgent(runInput({ history }), testDeps(llm));

    expect(history).toEqual(before);
    expect(llm.requests[0]?.messages.slice(0, 2)).toEqual(before);
    // The new assistant message keeps the provider's thinking block untouched.
    expect(result.newMessages[1]).toMatchObject({
      role: 'assistant',
      content: expect.arrayContaining([
        {
          type: 'opaque',
          provider: 'anthropic',
          data: { type: 'thinking', thinking: '', signature: 'sig-new' },
        },
      ]),
    });
  });

  it('only appends: every request extends the previous one', async () => {
    const llm = new FakeLlm([gatherStep(), presentStep('t1', { days: 1 }), presentStep('t2')]);
    const result = await runAgent(runInput({ history }), testDeps(llm));

    expect(result.status).toBe('ok');
    for (let index = 1; index < llm.requests.length; index += 1) {
      const previous = llm.requests[index - 1]?.messages ?? [];
      expect(llm.requests[index]?.messages.slice(0, previous.length)).toEqual(previous);
    }
    expect(llm.requests.at(-1)?.messages).toEqual([...history, ...result.newMessages.slice(0, -1)]);
  });

  it('answers open calls left in the history before the new user text', async () => {
    const llm = new FakeLlm([clarificationStep()]);
    await runAgent(runInput({ history }), testDeps(llm));

    const turn = llm.requests[0]?.messages[2];
    expect(turn?.role).toBe('user');
    expect(turn?.content[0]).toEqual({
      type: 'tool_result',
      toolCallId: 'c0',
      content: 'Delivered to the user.',
      isError: false,
    });
  });

  it('returns frozen messages', async () => {
    const result = await runAgent(runInput(), testDeps(new FakeLlm([clarificationStep()])));
    expect(Object.isFrozen(result.newMessages)).toBe(true);
    expect(Object.isFrozen(result.newMessages[0])).toBe(true);
    expect(Object.isFrozen(result.newMessages[0]?.content[0])).toBe(true);
  });
});

describe('runAgent: cancellation', () => {
  it('rejects with the abort reason when the caller cancels', async () => {
    const controller = new AbortController();
    const llm = new FakeLlm([{ delayMs: 1_000, then: clarificationStep() }]);
    const pending = runAgent(runInput(), testDeps(llm, { signal: controller.signal }));
    setTimeout(() => controller.abort(new Error('client disconnected')), 10);

    await expect(pending).rejects.toThrow('client disconnected');
  });

  it('rejects immediately when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const llm = new FakeLlm([clarificationStep()]);
    await expect(
      runAgent(runInput(), testDeps(llm, { signal: controller.signal })),
    ).rejects.toThrow('gone');
    expect(llm.requests).toHaveLength(0);
  });
});
