import type { AgentLimits } from './types.js';

/**
 * Starting values of the run limits (plan §5.2), to be tuned with the evaluation results. They
 * are configuration, not measurements.
 *
 * - `maxOutputTokens` covers adaptive thinking plus a full itinerary in one non-streaming call.
 * - `maxRunCostUsd` is checked against a worst case (see `maxCallCostUsd`), so with a more
 *   expensive agent model (Sonnet, Opus) it must be raised or the first call is refused.
 */
export const DEFAULT_AGENT_LIMITS: AgentLimits = Object.freeze({
  maxSteps: 8,
  maxRepairs: 1,
  llmTimeoutMs: 45_000,
  toolTimeoutMs: 5_000,
  runDeadlineMs: 90_000,
  maxOutputTokens: 16_000,
  maxRunCostUsd: 0.1,
});
