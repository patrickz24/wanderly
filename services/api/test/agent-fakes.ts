/**
 * Fakes of the agent runtime and its LLM / knowledge ports for use case and HTTP tests: a
 * scripted `runAgent` replaces the model, so no test ever calls a provider.
 */
import type { RunAgent } from '../src/application/ports/agent-runner.js';
import type {
  AgentFailureReason,
  AgentLimits,
  AgentRunDeps,
  AgentRunInput,
  AgentRunResult,
  AgentRunSignals,
  ModelPricing,
} from '../src/domain/agent/types.js';
import type { KnownDomainError } from '../src/domain/errors.js';
import type { KnowledgeRepository, Retriever } from '../src/domain/ports/knowledge.js';
import type { LlmPort, LlmResponse } from '../src/domain/ports/llm.js';
import { ANSWER, SOURCES, TOOL_CALLS, exchange } from './application-fakes.js';

export const TEST_PRICING: ModelPricing = {
  inputPerMTok: 0.1,
  outputPerMTok: 0.5,
  cacheReadPerMTok: 0.01,
  cacheWritePerMTok: 0.125,
};

export const TEST_LIMITS: AgentLimits = {
  maxSteps: 8,
  maxRepairs: 1,
  llmTimeoutMs: 45_000,
  toolTimeoutMs: 5_000,
  runDeadlineMs: 90_000,
  maxOutputTokens: 4_096,
  maxRunCostUsd: 0.05,
};

/** An LLM port that must not be reached unless a test scripts it. */
export function fakeLlm(
  generate: LlmPort['generate'] = () => Promise.reject(new Error('unexpected LLM call')),
): LlmPort {
  return { provider: 'fake', model: 'fake-model', generate };
}

export const FAKE_RETRIEVER: Retriever = { search: async () => [] };

export const FAKE_KNOWLEDGE: KnowledgeRepository = {
  listDestinations: async () => [],
  getClimate: async () => null,
  getCosts: async () => null,
  searchPois: async () => [],
};

export function llmResponse(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'fake-model',
    providerRequestId: null,
    ...overrides,
  };
}

export const NO_SIGNALS: AgentRunSignals = {
  canaryLeak: false,
  providerRefusal: false,
  injectionSignals: [],
};

export function okResult(
  input: AgentRunInput,
  overrides: Partial<Extract<AgentRunResult, { status: 'ok' }>> = {},
): AgentRunResult {
  return {
    status: 'ok',
    response: ANSWER,
    sources: SOURCES,
    validFirstTry: true,
    newMessages: exchange(input.userText),
    toolCalls: TOOL_CALLS,
    usage: { inputTokens: 3_000, outputTokens: 600, cacheReadTokens: 1_500, cacheWriteTokens: 0 },
    costUsd: 0.000615,
    steps: 2,
    repairs: 0,
    latencyMs: 1_234,
    signals: NO_SIGNALS,
    ...overrides,
  };
}

export function errorResult(
  input: AgentRunInput,
  error: KnownDomainError,
  reason: AgentFailureReason,
  overrides: Partial<Extract<AgentRunResult, { status: 'error' }>> = {},
): AgentRunResult {
  return {
    status: 'error',
    error,
    reason,
    newMessages: exchange(input.userText),
    toolCalls: TOOL_CALLS,
    usage: { inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.0004,
    steps: 2,
    repairs: 0,
    latencyMs: 2_000,
    signals: NO_SIGNALS,
    ...overrides,
  };
}

/** A runAgent fake that reports the tool events of TOOL_CALLS, then returns `respond(input)`. */
export function scriptedRunAgent(
  respond: (
    input: AgentRunInput,
    deps: AgentRunDeps,
  ) => Promise<AgentRunResult> | AgentRunResult = (input) => okResult(input),
): RunAgent & { readonly calls: Array<{ input: AgentRunInput; deps: AgentRunDeps }> } {
  const calls: Array<{ input: AgentRunInput; deps: AgentRunDeps }> = [];
  const run: RunAgent = async (input, deps) => {
    calls.push({ input, deps });
    for (const call of TOOL_CALLS) {
      deps.onEvent({
        type: 'tool.started',
        callId: call.callId,
        name: call.name,
        input: call.input,
      });
      deps.onEvent({ type: 'tool.finished', call });
    }
    return respond(input, deps);
  };
  return Object.assign(run, { calls });
}
