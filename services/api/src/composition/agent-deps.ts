import { DEFAULT_AGENT_LIMITS } from '../domain/agent/limits.js';
import type { AgentLimits } from '../domain/agent/types.js';
import { ProviderUnavailableError } from '../domain/errors.js';
import type { LlmPort } from '../domain/ports/llm.js';
import {
  ANTHROPIC_PROVIDER,
  createAnthropicLlm,
  type AnthropicEffort,
} from '../infrastructure/llm/anthropic-llm.js';

/**
 * Factories of the agent's model port and run limits, shared by the HTTP server (`main.ts`) and
 * the offline evaluation (`evals/runner/agent.ts`), so the evaluation runs the agent with the
 * same adapter, retries, effort and limits as production.
 */

export interface AgentLlmSettings {
  /** Revealed by the caller (a composition root); undefined when no key is configured. */
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly effort: AnthropicEffort;
  readonly timeoutMs: number;
  readonly maxRetries?: number;
}

/**
 * The Anthropic adapter, or, without an API key, a port that fails every call as "provider
 * unavailable" without any network access: the rest of the API (conversations, history,
 * feedback) keeps working and runs end with a clear error event.
 */
export function createAgentLlm(
  settings: AgentLlmSettings,
  warn: (details: Record<string, unknown>, message: string) => void,
): LlmPort {
  const { apiKey } = settings;
  if (apiKey === undefined) {
    return {
      provider: ANTHROPIC_PROVIDER,
      model: settings.model,
      generate: () => Promise.reject(new ProviderUnavailableError(ANTHROPIC_PROVIDER)),
    };
  }
  return createAnthropicLlm({
    apiKey,
    model: settings.model,
    effort: settings.effort,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    logger: { warn },
  });
}

export interface AgentLimitSettings {
  readonly llmTimeoutMs: number;
  readonly runDeadlineMs: number;
  readonly maxSteps: number;
  readonly maxRunCostUsd: number | undefined;
}

/** Run limits: the runtime's defaults, with the deadlines and budgets set by configuration. */
export function agentLimits(settings: AgentLimitSettings): AgentLimits {
  return {
    ...DEFAULT_AGENT_LIMITS,
    llmTimeoutMs: settings.llmTimeoutMs,
    runDeadlineMs: settings.runDeadlineMs,
    maxSteps: settings.maxSteps,
    ...(settings.maxRunCostUsd === undefined ? {} : { maxRunCostUsd: settings.maxRunCostUsd }),
  };
}
