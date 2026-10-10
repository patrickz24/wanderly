import { describe, expect, it } from 'vitest';
import { DEFAULT_RRF_K, reciprocalRankFusion } from './rrf.js';

describe('reciprocalRankFusion', () => {
  it('sums 1 / (k + rank) over the lists that contain an id', () => {
    const fused = reciprocalRankFusion({ vector: ['a', 'b'], fullText: ['b', 'c'] });

    const byId = Object.fromEntries(fused.map((result) => [result.id, result.score]));
    expect(byId['a']).toBeCloseTo(1 / 61, 12);
    expect(byId['b']).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(byId['c']).toBeCloseTo(1 / 62, 12);
    expect(fused.map((result) => result.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the 1-based rank of each list, null when absent', () => {
    const fused = reciprocalRankFusion({ vector: ['a', 'b'], fullText: ['b', 'c'] });

    expect(fused.map((result) => [result.id, result.ranks])).toEqual([
      ['b', { vector: 2, fullText: 1 }],
      ['a', { vector: 1, fullText: null }],
      ['c', { vector: null, fullText: 2 }],
    ]);
  });

  it('uses k = 60 by default and accepts another k', () => {
    expect(DEFAULT_RRF_K).toBe(60);
    const [top] = reciprocalRankFusion({ only: ['a'] }, { k: 1 });
    expect(top?.score).toBe(0.5);
  });

  it('rewards agreement between lists over a single first place', () => {
    const fused = reciprocalRankFusion({
      vector: ['solo', 'shared'],
      fullText: ['other', 'shared'],
    });

    expect(fused[0]?.id).toBe('shared');
  });

  it('breaks a score tie in favour of the better best rank', () => {
    // k = 1: x = 1/2 (rank 1 in `two`), y = 1/4 + 1/4 = 1/2 (rank 3 in both lists).
    const fused = reciprocalRankFusion({ one: ['p', 'q', 'y'], two: ['x', 'r', 'y'] }, { k: 1 });

    // p and x tie (1/2, best rank 1): `one` comes first. y ties too but its best rank is 3.
    expect(fused.map((result) => result.id)).toEqual(['p', 'x', 'y', 'q', 'r']);
  });

  it('breaks a remaining tie by the rank in the earliest list', () => {
    const symmetric = reciprocalRankFusion({ vector: ['x', 'y'], fullText: ['y', 'x'] });
    expect(symmetric.map((result) => result.id)).toEqual(['x', 'y']);

    const disjoint = reciprocalRankFusion({ vector: ['q'], fullText: ['p'] });
    expect(disjoint.map((result) => result.id)).toEqual(['q', 'p']);
  });

  it('is deterministic whatever the insertion order of the ids', () => {
    const forward = reciprocalRankFusion({ one: ['b', 'a'], two: ['a', 'b'] });
    const backward = reciprocalRankFusion({ one: ['a', 'b'], two: ['b', 'a'] });

    expect(forward.map((result) => result.id)).toEqual(['b', 'a']);
    expect(backward.map((result) => result.id)).toEqual(['a', 'b']);
    expect(forward[0]?.score).toBe(backward[0]?.score);
  });

  it('keeps the best rank of an id repeated inside a list', () => {
    const [top] = reciprocalRankFusion({ vector: ['a', 'a', 'b'] });

    expect(top).toEqual({ id: 'a', score: 1 / 61, ranks: { vector: 1 } });
  });

  it('applies the limit after fusion and handles empty input', () => {
    expect(reciprocalRankFusion({ vector: ['a', 'b', 'c'] }, { limit: 2 })).toHaveLength(2);
    expect(reciprocalRankFusion({ vector: [], fullText: [] })).toEqual([]);
    expect(reciprocalRankFusion({})).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects k = %s', (k) => {
    expect(() => reciprocalRankFusion({ vector: ['a'] }, { k })).toThrow(RangeError);
  });

  it.each([-1, 1.5])('rejects limit = %s', (limit) => {
    expect(() => reciprocalRankFusion({ vector: ['a'] }, { limit })).toThrow(RangeError);
  });
});
