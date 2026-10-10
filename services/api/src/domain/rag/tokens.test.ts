import { describe, expect, it } from 'vitest';
import { estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('counts one token per short word and per symbol', () => {
    expect(estimateTokens('Hiking on Etna.')).toBe(4);
    expect(estimateTokens('€50-80 (per night)')).toBe(8);
  });

  it('counts long words as several sub-word tokens', () => {
    expect(estimateTokens('accommodation')).toBe(2); // 13 characters
    expect(estimateTokens('a'.repeat(15))).toBe(3);
  });

  it('handles accents, non-Latin scripts and blank text', () => {
    expect(estimateTokens('Ηράκλειον café')).toBe(3);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' \n\t ')).toBe(0);
  });
});
