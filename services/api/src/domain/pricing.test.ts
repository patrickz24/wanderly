import { describe, expect, it } from 'vitest';
import type { ModelPricing } from './agent/types.js';
import { costUsd, maxCallCostUsd, promptTokens, ratesFor } from './pricing.js';

const HAIKU: ModelPricing = {
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
};

describe('costUsd', () => {
  it('prices each token class at its rate', () => {
    const usage = {
      inputTokens: 2_000,
      outputTokens: 1_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 4_000,
    };
    // (2000 × 0.1 + 1000 × 0.5 + 10000 × 0.01 + 4000 × 0.125) / 1e6
    expect(costUsd(usage, HAIKU)).toBeCloseTo(0.0013, 12);
    expect(promptTokens(usage)).toBe(16_000);
  });

  it('switches to the long-context rates above the threshold (whole prompt counts)', () => {
    const usage = {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
    };
    // (1000 × 0.5 + 1000 × 2.5 + 100000 × 0.05) / 1e6
    expect(costUsd(usage, HAIKU)).toBeCloseTo(0.008, 12);
    expect(ratesFor(HAIKU, 100_000)).toBe(HAIKU);
    const { longContext: _ignored, ...flat } = HAIKU;
    expect(ratesFor(flat, 1_000_000)).toBe(flat);
  });

  it('is zero for zero usage', () => {
    expect(
      costUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, HAIKU),
    ).toBe(0);
  });
});

describe('maxCallCostUsd', () => {
  it('bounds a call by its whole prompt at the cache-write rate plus max_tokens of output', () => {
    // 30 000 chars → 10 000 tokens × 0.125 + 16 000 × 0.5
    expect(maxCallCostUsd(30_000, 16_000, HAIKU)).toBeCloseTo(0.00925, 12);
  });

  it('uses the long-context rates for a long prompt', () => {
    // 330 000 chars → 110 000 tokens × 0.625 + 1 000 × 2.5
    expect(maxCallCostUsd(330_000, 1_000, HAIKU)).toBeCloseTo(0.07125, 12);
  });
});
