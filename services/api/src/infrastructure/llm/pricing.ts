import type { ModelPricing } from '../../domain/agent/types.js';

/**
 * Anthropic list prices in USD per million tokens, the single table behind every cost figure
 * (per-run ceiling, traces, daily budget cap). Source: the claude-api skill's model table and
 * migration guide, checked on 2026-10-09; re-check https://platform.claude.com/docs pricing
 * before changing a model.
 *
 * - Cache reads and 5-minute cache writes follow the published multipliers (0.1× and 1.25× the
 *   input rate), except Opus 5.5 whose cache reads are listed at $0.20 (0.05×).
 * - Haiku 5.5 bills prompts above 100K tokens on a second rate card ($0.50 / $2.50).
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0.125,
    longContext: {
      thresholdTokens: 100_000,
      rates: {
        inputPerMTok: 0.5,
        outputPerMTok: 2.5,
        cacheReadPerMTok: 0.05,
        cacheWritePerMTok: 0.625,
      },
    },
  },
  'claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  },
  'claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
  },
});

export class UnknownModelPricingError extends Error {
  constructor(readonly model: string) {
    super(
      `No price for model "${model}". Add it to MODEL_PRICING (infrastructure/llm/pricing.ts) from the provider's published prices; known models: ${Object.keys(MODEL_PRICING).join(', ')}.`,
    );
    this.name = 'UnknownModelPricingError';
  }
}

/** Prices of a configured model; call at startup so an unknown model fails fast. */
export function pricingFor(model: string): ModelPricing {
  const pricing = Object.hasOwn(MODEL_PRICING, model) ? MODEL_PRICING[model] : undefined;
  if (pricing === undefined) throw new UnknownModelPricingError(model);
  return pricing;
}
