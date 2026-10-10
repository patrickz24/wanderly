import type {
  AssistantBlock,
  LlmCallOptions,
  LlmPort,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  OpaqueBlock,
  StopReason,
  TextBlock,
  ToolCallBlock,
} from '../../src/domain/ports/llm.js';

/**
 * A scripted `LlmPort`: returns queued responses in order and records every request. Used by the
 * agent's unit tests, and usable as a deterministic stand-in (e.g. a null-baseline eval run)
 * wherever a real model is not wanted. It never calls a network.
 */
export type FakeLlmStep =
  | LlmResponse
  | ((request: LlmRequest, options: LlmCallOptions) => LlmResponse | Promise<LlmResponse>)
  | { readonly throws: Error }
  | { readonly delayMs: number; readonly then: FakeLlmStep };

export class FakeLlm implements LlmPort {
  readonly provider: string;
  readonly model: string;
  /** Deep copies of the requests received, in order. */
  readonly requests: LlmRequest[] = [];
  readonly #script: FakeLlmStep[];

  constructor(
    script: readonly FakeLlmStep[],
    options: { readonly model?: string; readonly provider?: string } = {},
  ) {
    this.#script = [...script];
    this.model = options.model ?? 'fake-model';
    this.provider = options.provider ?? 'fake';
  }

  /** Scripted steps not consumed yet. */
  get remaining(): number {
    return this.#script.length;
  }

  async generate(request: LlmRequest, options: LlmCallOptions): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    const step = this.#script.shift();
    if (step === undefined) {
      throw new Error(`FakeLlm: no scripted response left for call ${this.requests.length}`);
    }
    return play(step, request, options);
  }
}

async function play(
  step: FakeLlmStep,
  request: LlmRequest,
  options: LlmCallOptions,
): Promise<LlmResponse> {
  if (typeof step === 'function') return step(request, options);
  if ('throws' in step) throw step.throws;
  if ('delayMs' in step) {
    await sleep(step.delayMs, options.signal);
    return play(step.then, request, options);
  }
  return step;
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Builders ------------------------------------------------------------------------------------

export const DEFAULT_FAKE_USAGE: LlmUsage = Object.freeze({
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function text(value: string): TextBlock {
  return { type: 'text', text: value };
}

export function toolCall(id: string, name: string, input: unknown): ToolCallBlock {
  return { type: 'tool_call', id, name, input };
}

/** An Anthropic-style signed thinking block, carried as an opaque block. */
export function thinking(signature: string, provider = 'anthropic'): OpaqueBlock {
  return { type: 'opaque', provider, data: { type: 'thinking', thinking: '', signature } };
}

export function reply(
  content: readonly AssistantBlock[],
  options: {
    readonly stopReason?: StopReason;
    readonly usage?: LlmUsage;
    readonly model?: string;
  } = {},
): LlmResponse {
  const hasToolCall = content.some((block) => block.type === 'tool_call');
  return {
    content,
    stopReason: options.stopReason ?? (hasToolCall ? 'tool_use' : 'end_turn'),
    usage: options.usage ?? DEFAULT_FAKE_USAGE,
    model: options.model ?? 'fake-model',
    providerRequestId: null,
  };
}
