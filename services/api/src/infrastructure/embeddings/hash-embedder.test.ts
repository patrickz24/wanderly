import { describe, expect, it } from 'vitest';
import { HashEmbedder } from './hash-embedder.js';

const dot = (left: readonly number[], right: readonly number[]): number =>
  left.reduce((total, value, index) => total + value * (right[index] ?? 0), 0);

describe('HashEmbedder', () => {
  const embedder = new HashEmbedder();

  it('returns unit vectors of the requested size', async () => {
    const [vector] = await embedder.embed(['Mount Etna offers volcanic hikes'], 'document');

    expect(embedder.dimensions).toBe(384);
    expect(embedder.model).toBe('hash-bow-384');
    expect(vector).toHaveLength(384);
    expect(dot(vector ?? [], vector ?? [])).toBeCloseTo(1, 10);
  });

  it('is deterministic and ignores case and punctuation', async () => {
    const [first, second] = await embedder.embed(['Etna, hiking!', 'etna hiking'], 'document');

    expect(first).toEqual(second);
  });

  it('places texts that share words closer than unrelated texts', async () => {
    const [query, related, unrelated] = await embedder.embed(
      ['hiking etna volcano', 'guided hiking on the etna volcano', 'beaches of crete'],
      'query',
    );

    expect(dot(query ?? [], related ?? [])).toBeGreaterThan(dot(query ?? [], unrelated ?? []));
  });

  it('gives a text without words a fixed unit vector instead of a zero vector', async () => {
    const [vector] = await embedder.embed(['— !'], 'document');

    expect(vector?.[0]).toBe(1);
    expect(dot(vector ?? [], vector ?? [])).toBe(1);
  });

  it('supports other sizes and rejects invalid ones', async () => {
    const small = new HashEmbedder(8);
    const [vector] = await small.embed(['a b c'], 'document');

    expect(vector).toHaveLength(8);
    expect(() => new HashEmbedder(1)).toThrow(RangeError);
    expect(() => new HashEmbedder(2.5)).toThrow(RangeError);
  });
});
