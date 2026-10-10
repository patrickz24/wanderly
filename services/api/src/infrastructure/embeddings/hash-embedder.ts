import type { Embedder, EmbeddingKind } from '../../domain/ports/knowledge.js';

const WORD = /[\p{L}\p{N}]+/gu;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Deterministic bag-of-words embedder for tests: each lower-cased word is hashed (FNV-1a) into
 * one signed dimension and the vector is L2-normalized, so texts sharing words are close in
 * cosine distance. No model, no I/O, same output on every machine. Not a semantic model.
 */
export class HashEmbedder implements Embedder {
  readonly model: string;

  constructor(readonly dimensions = 384) {
    if (!Number.isInteger(dimensions) || dimensions < 2) {
      throw new RangeError('dimensions must be an integer >= 2');
    }
    this.model = `hash-bow-${dimensions}`;
  }

  async embed(texts: readonly string[], _kind: EmbeddingKind): Promise<number[][]> {
    return texts.map((text) => this.#vector(text));
  }

  #vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const match of text.toLowerCase().matchAll(WORD)) {
      const hash = fnv1a(match[0]);
      const index = hash % this.dimensions;
      vector[index] = (vector[index] ?? 0) + (hash & 0x80000000 ? -1 : 1);
    }
    const norm = Math.hypot(...vector);
    // A text without words gets a fixed unit vector: a zero vector has no cosine distance.
    if (norm === 0) return vector.map((_, index) => (index === 0 ? 1 : 0));
    return vector.map((value) => value / norm);
  }
}

function fnv1a(word: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < word.length; index++) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}
