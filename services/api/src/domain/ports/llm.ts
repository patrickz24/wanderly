/**
 * Provider-neutral LLM port. The agent loop only speaks this vocabulary; an adapter per provider
 * (Anthropic today) maps it to the provider's SDK.
 *
 * Why `opaque` blocks: providers return content the domain must not interpret but must replay
 * verbatim on the next request (e.g. Claude's signed `thinking` blocks — editing or dropping them
 * breaks the next call). The adapter stores such blocks as `opaque`, tagged with its provider,
 * and drops blocks tagged with another provider, so a conversation can switch providers without
 * rewriting the agent. A lowest-common-denominator "text + tool calls" type would lose them.
 */

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolCallBlock {
  readonly type: 'tool_call';
  /** Provider-issued id, echoed by the matching tool result. */
  readonly id: string;
  readonly name: string;
  /** Raw arguments as parsed JSON; always validated before use. */
  readonly input: unknown;
}

export interface OpaqueBlock {
  readonly type: 'opaque';
  /** Adapter that produced the block (e.g. "anthropic"); other adapters drop it. */
  readonly provider: string;
  /** Provider-native block, replayed unchanged. JSON-serializable. */
  readonly data: unknown;
}

export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly toolCallId: string;
  /** Serialized result (JSON text) or a short error message. */
  readonly content: string;
  readonly isError: boolean;
}

export type AssistantBlock = TextBlock | ToolCallBlock | OpaqueBlock;
export type UserBlock = TextBlock | ToolResultBlock;

export type LlmMessage =
  | { readonly role: 'user'; readonly content: readonly UserBlock[] }
  | { readonly role: 'assistant'; readonly content: readonly AssistantBlock[] };

export interface ToolSpec {
  readonly name: string;
  /** Written for the model: what the tool does, when to use it, what it returns. */
  readonly description: string;
  /** JSON Schema of the input (draft 2020-12 subset accepted by the provider). */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Ask the provider to constrain arguments to the schema (strict tool use). */
  readonly strict: boolean;
}

export interface LlmRequest {
  /** Static instructions; adapters may cache it (render order: tools, system, messages). */
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  /** Append-only conversation; must end with a user message. */
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface LlmResponse {
  /** Blocks in provider order (opaque reasoning blocks may precede text and tool calls). */
  readonly content: readonly AssistantBlock[];
  readonly stopReason: StopReason;
  readonly usage: LlmUsage;
  /** Model that actually served the request, as reported by the provider. */
  readonly model: string;
  readonly providerRequestId: string | null;
}

export interface LlmCallOptions {
  /** Aborts the call; adapters translate an abort caused by a deadline into `LlmTimeoutError`. */
  readonly signal: AbortSignal;
}

/**
 * Throws `LlmTimeoutError` on timeout and `ProviderUnavailableError` when the provider stays
 * unavailable after the adapter's bounded retries. Never throws provider-specific errors.
 */
export interface LlmPort {
  readonly provider: string;
  readonly model: string;
  generate(request: LlmRequest, options: LlmCallOptions): Promise<LlmResponse>;
}

export const ZERO_USAGE: LlmUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
