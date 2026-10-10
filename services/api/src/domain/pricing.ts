import type { ModelPricing, ModelRates } from './agent/types.js';
import type { LlmUsage } from './ports/llm.js';

/**
 * LLM cost arithmetic, shared by the agent's per-run ceiling, the traces and the daily budget
 * cap, so that every place reports the same number for the same call.
 */

const PER_MILLION = 1_000_000;

/** Tokens the provider read for the prompt: uncached + cache reads + cache writes. */
export function promptTokens(usage: LlmUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Rates that apply to a prompt of this size (some models bill long prompts at a higher rate). */
export function ratesFor(pricing: ModelPricing, prompt: number): ModelRates {
  const long = pricing.longContext;
  return long !== undefined && prompt > long.thresholdTokens ? long.rates : pricing;
}

/** Cost in USD of one call, from the usage the provider reported. */
export function costUsd(usage: LlmUsage, pricing: ModelPricing): number {
  const rates = ratesFor(pricing, promptTokens(usage));
  return (
    (usage.inputTokens * rates.inputPerMTok +
      usage.outputTokens * rates.outputPerMTok +
      usage.cacheReadTokens * rates.cacheReadPerMTok +
      usage.cacheWriteTokens * rates.cacheWritePerMTok) /
    PER_MILLION
  );
}

/**
 * Conservative characters-per-token ratio for estimating a prompt before sending it. Real ratios
 * for English and JSON are higher (more characters per token), so this over-estimates on purpose.
 */
export const CHARS_PER_TOKEN_LOWER_BOUND = 3;

/**
 * Upper bound of the cost of a call that has not been made yet: the whole prompt billed at the
 * most expensive input rate (a cache write) and the full `max_tokens` billed as output. Used to
 * stop a run BEFORE a call that could cross its cost ceiling.
 */
export function maxCallCostUsd(
  promptChars: number,
  maxOutputTokens: number,
  pricing: ModelPricing,
): number {
  const prompt = Math.ceil(promptChars / CHARS_PER_TOKEN_LOWER_BOUND);
  const rates = ratesFor(pricing, prompt);
  const inputRate = Math.max(rates.inputPerMTok, rates.cacheWritePerMTok);
  return (prompt * inputRate + maxOutputTokens * rates.outputPerMTok) / PER_MILLION;
}
