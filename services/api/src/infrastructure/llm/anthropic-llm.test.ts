import type Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { LlmTimeoutError, ProviderUnavailableError } from '../../domain/errors.js';
import type { LlmMessage, LlmRequest } from '../../domain/ports/llm.js';
import { AGENT_TOOL_SPECS } from '../../domain/tools/registry.js';
import {
  AnthropicLlm,
  createAnthropicLlm,
  type LlmLogger,
  type MessagesApi,
  toMessageParams,
  toStopReason,
} from './anthropic-llm.js';

const MODEL = 'claude-haiku-5-5';

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    container: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'Searching.', citations: null },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'search_knowledge',
        input: { query: 'hiking' },
        caller: { type: 'direct' },
      },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 80,
      cache_read_input_tokens: 4_000,
      cache_creation_input_tokens: 300,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
    ...overrides,
  };
}

function setup(response: Anthropic.Message | Error = message()) {
  const create = vi.fn<MessagesApi['create']>(async () => {
    if (response instanceof Error) throw response;
    return Object.defineProperty({ ...response }, '_request_id', {
      value: 'req_123',
      enumerable: false,
    });
  });
  const warn = vi.fn<LlmLogger['warn']>();
  const llm = new AnthropicLlm({
    messages: { create },
    model: MODEL,
    effort: 'medium',
    timeoutMs: 45_000,
    logger: { warn },
  });
  return { llm, create, warn };
}

const history: LlmMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  {
    role: 'assistant',
    content: [
      {
        type: 'opaque',
        provider: 'anthropic',
        data: { type: 'thinking', thinking: '', signature: 'sig-0' },
      },
      { type: 'opaque', provider: 'other', data: { reasoning: 'not ours' } },
      { type: 'tool_call', id: 'toolu_0', name: 'search_knowledge', input: { query: 'x' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', toolCallId: 'toolu_0', content: '{"results":[]}', isError: false },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: 'And Crete?' }] },
];

const request: LlmRequest = {
  system: 'You are Wanderly.',
  tools: AGENT_TOOL_SPECS,
  messages: history,
  maxTokens: 16_000,
};

describe('AnthropicLlm request', () => {
  it('sends a cacheable, strict, auto-tool-choice request without sampling parameters', async () => {
    const { llm, create } = setup();
    const signal = new AbortController().signal;
    await llm.generate(request, { signal });

    const [body, options] = create.mock.calls[0]!;
    expect(options).toEqual({ signal, timeout: 45_000 });
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: 16_000,
      system: [{ type: 'text', text: 'You are Wanderly.', cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'auto' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    });
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'stream']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.tools).toHaveLength(AGENT_TOOL_SPECS.length);
    expect(body.tools?.every((tool) => 'strict' in tool && tool.strict === true)).toBe(true);
    const cached = body.tools?.flatMap((tool) =>
      'cache_control' in tool && tool.cache_control !== undefined && 'name' in tool
        ? [tool.name]
        : [],
    );
    expect(cached).toEqual(['decline']);
  });

  it('replays its own opaque blocks verbatim, drops other providers, merges consecutive user turns', async () => {
    const { llm, create } = setup();
    await llm.generate(request, { signal: new AbortController().signal });

    expect(create.mock.calls[0]![0].messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-0' },
          { type: 'tool_use', id: 'toolu_0', name: 'search_knowledge', input: { query: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_0',
            content: '{"results":[]}',
            is_error: false,
          },
          { type: 'text', text: 'And Crete?' },
        ],
      },
    ]);
  });

  it('drops a message left empty after filtering', () => {
    expect(
      toMessageParams([
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', content: [{ type: 'opaque', provider: 'other', data: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ]);
  });

  it('rejects a tool whose schema is not an object schema', async () => {
    const { llm } = setup();
    const bad = {
      ...request,
      tools: [{ name: 'x', description: 'd', inputSchema: { type: 'string' }, strict: true }],
    };
    await expect(llm.generate(bad, { signal: new AbortController().signal })).rejects.toThrow(
      /object schema/,
    );
  });
});

describe('AnthropicLlm response', () => {
  it('maps blocks, usage, model and request id', async () => {
    const { llm, warn } = setup();
    const response = await llm.generate(request, { signal: new AbortController().signal });

    expect(response).toEqual({
      content: [
        {
          type: 'opaque',
          provider: 'anthropic',
          data: { type: 'thinking', thinking: '', signature: 'sig-1' },
        },
        { type: 'text', text: 'Searching.' },
        { type: 'tool_call', id: 'toolu_1', name: 'search_knowledge', input: { query: 'hiking' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 4_000, cacheWriteTokens: 300 },
      model: MODEL,
      providerRequestId: 'req_123',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats missing cache counters as zero', async () => {
    const base = message();
    const { llm } = setup(
      message({
        usage: { ...base.usage, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      }),
    );
    const response = await llm.generate(request, { signal: new AbortController().signal });
    expect(response.usage).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('warns when the served model differs from the requested one', async () => {
    const { llm, warn } = setup(message({ model: 'claude-sonnet-5-5' }));
    await llm.generate(request, { signal: new AbortController().signal });
    expect(warn).toHaveBeenCalledWith(
      { requestedModel: MODEL, servedModel: 'claude-sonnet-5-5' },
      'The provider served a different model than requested',
    );
  });

  it.each([
    ['end_turn', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'other'],
    ['stop_sequence', 'other'],
    [null, 'other'],
  ] as const)('maps stop reason %s to %s', (reason, expected) => {
    expect(toStopReason(reason)).toBe(expected);
  });
});

describe('AnthropicLlm errors', () => {
  const headers = new Headers();
  it.each([
    ['an abort (our deadline)', new APIUserAbortError(), LlmTimeoutError],
    ['an SDK timeout', new APIConnectionTimeoutError(), LlmTimeoutError],
    ['a 429', new RateLimitError(429, {}, 'rate limited', headers), ProviderUnavailableError],
    ['a 529', new InternalServerError(529, {}, 'overloaded', headers), ProviderUnavailableError],
    ['a 500', new InternalServerError(500, {}, 'oops', headers), ProviderUnavailableError],
    [
      'a connection error',
      new APIConnectionError({ message: 'ECONNRESET' }),
      ProviderUnavailableError,
    ],
  ])('maps %s to a domain error', async (_label, error, expected) => {
    const { llm } = setup(error);
    await expect(
      llm.generate(request, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(expected);
  });

  it('keeps the HTTP status of an unavailable provider', async () => {
    const { llm } = setup(new InternalServerError(529, {}, 'overloaded', headers));
    await expect(
      llm.generate(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { provider: 'anthropic', status: 529 },
    });
  });

  it.each([
    ['a 400', new BadRequestError(400, {}, 'invalid', headers)],
    ['a 401', new AuthenticationError(401, {}, 'bad key', headers)],
    ['an unknown error', new TypeError('bug')],
  ])('rethrows %s unchanged', async (_label, error) => {
    const { llm } = setup(error);
    await expect(llm.generate(request, { signal: new AbortController().signal })).rejects.toBe(
      error,
    );
  });
});

describe('createAnthropicLlm', () => {
  it('builds an adapter for the configured model without calling the API', () => {
    const llm = createAnthropicLlm({
      apiKey: 'test-key',
      model: MODEL,
      effort: 'low',
      timeoutMs: 1_000,
    });
    expect(llm.provider).toBe('anthropic');
    expect(llm.model).toBe(MODEL);
  });
});
