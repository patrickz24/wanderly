import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Embedder, EmbeddingKind } from '../../services/api/src/domain/ports/knowledge.js';

/**
 * Embedding cache for the evaluation: chunking variants share most of their text, and every
 * strategy embeds the same queries, so each distinct (kind, text) is embedded once per model
 * configuration. Persisted as JSON lines so a later run re-embeds nothing that did not change.
 * The key includes the embedder's configuration: a cached vector is only reused by the same model.
 */
export class CachingEmbedder implements Embedder {
  readonly #vectors = new Map<string, number[]>();
  #misses = 0;
  #hits = 0;

  constructor(
    private readonly inner: Embedder,
    /** Model settings that change the vectors (pooling, query prefix, dtype…). */
    private readonly configuration: string,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  get stats(): { readonly hits: number; readonly misses: number; readonly size: number } {
    return { hits: this.#hits, misses: this.#misses, size: this.#vectors.size };
  }

  key(text: string, kind: EmbeddingKind): string {
    return createHash('sha256')
      .update(`${this.inner.model}\u0000${this.configuration}\u0000${kind}\u0000${text}`)
      .digest('hex');
  }

  /** Adds a vector computed elsewhere by the same model and configuration. */
  remember(text: string, kind: EmbeddingKind, vector: readonly number[]): void {
    if (vector.length !== this.inner.dimensions) throw new RangeError('wrong vector size');
    this.#vectors.set(this.key(text, kind), [...vector]);
  }

  async embed(texts: readonly string[], kind: EmbeddingKind): Promise<number[][]> {
    const missing = [...new Set(texts.filter((text) => !this.#vectors.has(this.key(text, kind))))];
    if (missing.length > 0) {
      const vectors = await this.inner.embed(missing, kind);
      missing.forEach((text, index) => {
        const vector = vectors[index];
        if (vector === undefined) throw new Error('embedder returned too few vectors');
        this.#vectors.set(this.key(text, kind), [...vector]);
      });
    }
    this.#misses += missing.length;
    this.#hits += texts.length - missing.length;
    return texts.map((text) => [...(this.#vectors.get(this.key(text, kind)) ?? [])]);
  }

  async load(file: string): Promise<number> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return 0;
      }
      throw error;
    }
    let loaded = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const entry: unknown = JSON.parse(line);
      if (isEntry(entry) && entry.vector.length === this.inner.dimensions) {
        this.#vectors.set(entry.key, entry.vector);
        loaded++;
      }
    }
    return loaded;
  }

  async save(file: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const lines = [...this.#vectors].map(([key, vector]) => JSON.stringify({ key, vector }));
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  }
}

function isEntry(value: unknown): value is { key: string; vector: number[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof value.key === 'string' &&
    'vector' in value &&
    Array.isArray(value.vector) &&
    value.vector.every((item: unknown) => typeof item === 'number')
  );
}
