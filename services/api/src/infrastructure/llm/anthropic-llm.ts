import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { LlmTimeoutError, ProviderUnavailableError } from '../../domain/errors.js';
import type {
  AssistantBlock,
  LlmCallOptions,
  LlmMessage,
  LlmPort,
  LlmRequest,
  LlmResponse,
  StopReason,
  ToolSpec,
  UserBlock,
} from '../../domain/ports/llm.js';

/**
 * `LlmPort` over the Anthropic Messages API (`@anthropic-ai/sdk`, non-streaming `messages.create`).
 *
 * Request shape (Claude Haiku/Sonnet/Opus 5.5 rules, checked in the claude-api skill on 2026-10-09):
 * - no `temperature` / `top_p` / `top_k` (non-default values are rejected); adaptive thinking is
 *   the default, so `thinking` is omitted and `output_config.effort` sets the depth;
 * - `tool_choice: auto` (forced tool choice is rejected on Sonnet/Opus 5.5) with `strict: true`
 *   tools; the system prompt tells the model to end with a terminal tool;
 * - prompt caching: breakpoints on the last tool and on the system prompt (render order is
 *   tools → system → messages), plus top-level automatic caching of the growing conversation;
 * - the SDK's own retries are bounded and its timeout equals our per-call deadline; the caller's
 *   AbortSignal is passed through, because the SDK also retries timeouts.
 *
 * Mapping: `text` and `tool_use` blocks become port blocks; every other block (thinking, redacted
 * thinking, …) becomes an `opaque` block tagged `anthropic` and is replayed verbatim. Opaque
 * blocks of another provider are dropped from requests.
 */

export const ANTHROPIC_PROVIDER = 'anthropic';
export const DEFAULT_MAX_RETRIES = 2;

export type AnthropicEffort = NonNullable<Anthropic.OutputConfig['effort']>;

/** The one SDK method the adapter uses; injected so tests can mock it. */
export interface MessagesApi {
  create(
    body: Anthropic.MessageCreateParamsNonStreaming,
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
  ): PromiseLike<Anthropic.Message & { readonly _request_id?: string | null }>;
}

/** Pino-compatible warning sink. */
export interface LlmLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface AnthropicLlmOptions {
  readonly messages: MessagesApi;
  readonly model: string;
  readonly effort: AnthropicEffort;
  /** Per-call deadline, also given to the SDK as its request timeout. */
  readonly timeoutMs: number;
  readonly logger?: LlmLogger;
}

export interface CreateAnthropicLlmOptions {
  /** Call `Secret.reveal()` at the composition root only. */
  readonly apiKey: string;
  readonly model: string;
  readonly effort: AnthropicEffort;
  readonly timeoutMs: number;
  readonly maxRetries?: number;
  readonly logger?: LlmLogger;
}

/** Builds the adapter with a real SDK client (bounded retries, timeout = per-call deadline). */
export function createAnthropicLlm(options: CreateAnthropicLlmOptions): AnthropicLlm {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: options.timeoutMs,
  });
  return new AnthropicLlm({
    messages: client.messages,
    model: options.model,
    effort: options.effort,
    timeoutMs: options.timeoutMs,
    logger: options.logger,
  });
}

const CONSOLE_LOGGER: LlmLogger = {
  warn: (details, message) => console.warn(message, details),
};

export class AnthropicLlm implements LlmPort {
  readonly provider = ANTHROPIC_PROVIDER;
  readonly model: string;
  readonly #messages: MessagesApi;
  readonly #effort: AnthropicEffort;
  readonly #timeoutMs: number;
  readonly #logger: LlmLogger;

  constructor(options: AnthropicLlmOptions) {
    this.model = options.model;
    this.#messages = options.messages;
    this.#effort = options.effort;
    this.#timeoutMs = options.timeoutMs;
    this.#logger = options.logger ?? CONSOLE_LOGGER;
  }

  async generate(request: LlmRequest, options: LlmCallOptions): Promise<LlmResponse> {
    const body = toRequestBody(request, this.model, this.#effort);
    let message: Anthropic.Message & { readonly _request_id?: string | null };
    try {
      message = await this.#messages.create(body, {
        signal: options.signal,
        timeout: this.#timeoutMs,
      });
    } catch (error) {
      throw toDomainError(error, this.#timeoutMs);
    }
    if (message.model !== this.model) {
      this.#logger.warn(
        { requestedModel: this.model, servedModel: message.model },
        'The provider served a different model than requested',
      );
    }
    return {
      content: message.content.map(fromContentBlock),
      stopReason: toStopReason(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: message.model,
      providerRequestId: message._request_id ?? null,
    };
  }
}

// --- Request mapping ------------------------------------------------------------------------------

const EPHEMERAL = { type: 'ephemeral' } as const;

export function toRequestBody(
  request: LlmRequest,
  model: string,
  effort: AnthropicEffort,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: request.maxTokens,
    system: [{ type: 'text', text: request.system, cache_control: EPHEMERAL }],
    tools: request.tools.map((tool, index) => toTool(tool, index === request.tools.length - 1)),
    tool_choice: { type: 'auto' },
    messages: toMessageParams(request.messages),
    output_config: { effort },
    // Automatic caching of the conversation: each step reads the prefix the previous one wrote.
    cache_control: EPHEMERAL,
  };
}

function toTool(tool: ToolSpec, isLast: boolean): Anthropic.Tool {
  if (tool.inputSchema.type !== 'object') {
    throw new Error(`Tool ${tool.name}: the input schema must be an object schema`);
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.inputSchema, type: 'object' },
    strict: tool.strict,
    ...(isLast ? { cache_control: EPHEMERAL } : {}),
  };
}

/**
 * Maps the port's messages, dropping other providers' opaque blocks and messages left empty,
 * then merging consecutive same-role messages (a run that failed leaves a user message, and the
 * next turn starts with another one). Deterministic, so a replayed prefix is byte-identical.
 */
export function toMessageParams(messages: readonly LlmMessage[]): Anthropic.MessageParam[] {
  const mapped = messages
    .map(toMessageParam)
    .filter((message) => Array.isArray(message.content) && message.content.length > 0);
  const merged: Anthropic.MessageParam[] = [];
  for (const message of mapped) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.role === message.role &&
      Array.isArray(previous.content) &&
      Array.isArray(message.content)
    ) {
      merged[merged.length - 1] = {
        role: previous.role,
        content: [...previous.content, ...message.content],
      };
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function toMessageParam(message: LlmMessage): Anthropic.MessageParam {
  if (message.role === 'user') {
    return { role: 'user', content: message.content.map(fromUserBlock) };
  }
  return {
    role: 'assistant',
    content: message.content.flatMap((block) => fromAssistantBlock(block)),
  };
}

function fromUserBlock(block: UserBlock): Anthropic.ContentBlockParam {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return {
    type: 'tool_result',
    tool_use_id: block.toolCallId,
    content: block.content,
    is_error: block.isError,
  };
}

function fromAssistantBlock(block: AssistantBlock): Anthropic.ContentBlockParam[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: block.text }];
    case 'tool_call':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
    case 'opaque':
      return block.provider === ANTHROPIC_PROVIDER && isContentBlockParam(block.data)
        ? [block.data]
        : [];
  }
}

/** Opaque data is a block this adapter produced: an object with a string `type`. */
function isContentBlockParam(data: unknown): data is Anthropic.ContentBlockParam {
  return (
    typeof data === 'object' && data !== null && 'type' in data && typeof data.type === 'string'
  );
}

// --- Response mapping -----------------------------------------------------------------------------

function fromContentBlock(block: Anthropic.ContentBlock): AssistantBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
    default:
      // Thinking, redacted thinking, server tool blocks…: replayed unchanged, never interpreted.
      return { type: 'opaque', provider: ANTHROPIC_PROVIDER, data: block };
  }
}

export function toStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return reason;
    case 'model_context_window_exceeded':
      // Output cut short as with max_tokens.
      return 'max_tokens';
    default:
      return 'other';
  }
}

// --- Errors ---------------------------------------------------------------------------------------

/**
 * Typed SDK errors → domain errors. Checked most specific first: a connection timeout is an
 * `APIConnectionError` subclass, and every class here is an `APIError` subclass.
 */
export function toDomainError(error: unknown, timeoutMs: number): unknown {
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    // The domain only aborts on deadlines.
    return new LlmTimeoutError(timeoutMs, { cause: error });
  }
  if (error instanceof RateLimitError || error instanceof InternalServerError) {
    // 429, 5xx and 529 (overloaded), after the SDK's bounded retries.
    return new ProviderUnavailableError(ANTHROPIC_PROVIDER, { status: error.status, cause: error });
  }
  if (error instanceof APIConnectionError) {
    return new ProviderUnavailableError(ANTHROPIC_PROVIDER, { cause: error });
  }
  // 400 (invalid request), 401/403 (key), 404 (model): bugs or configuration, not outages.
  return error;
}
