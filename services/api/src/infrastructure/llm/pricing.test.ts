import { describe, expect, it } from 'vitest';
import { costUsd } from '../../domain/pricing.js';
import { MODEL_PRICING, pricingFor, UnknownModelPricingError } from './pricing.js';

describe('pricingFor', () => {
  it('returns the list prices of the configured models', () => {
    expect(pricingFor('claude-haiku-5-5')).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(pricingFor('claude-sonnet-5-5')).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(pricingFor('claude-opus-5-5')).toMatchObject({ inputPerMTok: 4, cacheReadPerMTok: 0.2 });
  });

  it('fails explicitly for a model without a price', () => {
    expect(() => pricingFor('claude-unknown-9')).toThrow(UnknownModelPricingError);
    expect(() => pricingFor('constructor')).toThrow(/No price for model "constructor"/);
  });

  it('derives cache prices from the published multipliers', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.cacheWritePerMTok, model).toBeCloseTo(pricing.inputPerMTok * 1.25, 10);
      expect(pricing.cacheReadPerMTok, model).toBeLessThanOrEqual(
        pricing.inputPerMTok * 0.1 + 1e-12,
      );
    }
  });

  it('prices a Haiku call above 100K prompt tokens on the long-context rate card', () => {
    const usage = {
      inputTokens: 101_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(costUsd(usage, pricingFor('claude-haiku-5-5'))).toBeCloseTo(
      (101_000 * 0.5 + 1_000 * 2.5) / 1e6,
      12,
    );
  });
});
