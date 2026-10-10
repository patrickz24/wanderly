import { describe, expect, it, vi } from 'vitest';
import {
  BGE_QUERY_INSTRUCTION,
  EmbeddingModelError,
  TransformersEmbedder,
  createEmbedderReadinessCheck,
  type ExtractorFactory,
  type FeatureExtractor,
} from './transformers-embedder.js';

/** A fake pipeline: row i of a batch is [i + 1, 0, 0, …] of the requested size. */
function fakeExtractor(dimensions = 4, overrides: Partial<FeatureExtractor> = {}) {
  const calls: Array<{ texts: string[]; pooling: string; normalize: boolean }> = [];
  const extractor: FeatureExtractor = {
    async extract(texts, options) {
      calls.push({ texts, ...options });
      const data = new Float32Array(texts.length * dimensions);
      texts.forEach((_, row) => (data[row * dimensions] = row + 1));
      return { dims: [texts.length, dimensions], data };
    },
    countTokens: (text) => text.split(' ').length + 2,
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
  return { extractor, calls };
}

function embedderWith(extractor: FeatureExtractor, options: { batchSize?: number } = {}) {
  const loadExtractor = vi.fn<ExtractorFactory>(async () => extractor);
  const embedder = new TransformersEmbedder({
    model: 'Xenova/bge-small-en-v1.5',
    cacheDir: '/tmp/models',
    dimensions: 4,
    loadExtractor,
    ...options,
  });
  return { embedder, loadExtractor };
}

describe('TransformersEmbedder', () => {
  it('uses CLS pooling, normalization and the BGE query instruction by default', async () => {
    const { extractor, calls } = fakeExtractor();
    const { embedder } = embedderWith(extractor);

    await embedder.embed(['hiking on Etna'], 'query');
    await embedder.embed(['Mount Etna offers hikes.'], 'document');

    expect(embedder.pooling).toBe('cls');
    expect(BGE_QUERY_INSTRUCTION).toBe('Represent this sentence for searching relevant passages: ');
    // calls[0] is the dimension check made at load time.
    expect(calls[1]).toEqual({
      texts: [`${BGE_QUERY_INSTRUCTION}hiking on Etna`],
      pooling: 'cls',
      normalize: true,
    });
    expect(calls[2]?.texts).toEqual(['Mount Etna offers hikes.']);
  });

  it('accepts another pooling and an empty query prefix', async () => {
    const { extractor, calls } = fakeExtractor();
    const embedder = new TransformersEmbedder({
      model: 'm',
      cacheDir: 'c',
      dimensions: 4,
      pooling: 'mean',
      queryPrefix: '',
      loadExtractor: async () => extractor,
    });

    await embedder.embed(['q'], 'query');

    expect(calls[1]).toMatchObject({ texts: ['q'], pooling: 'mean' });
  });

  it('embeds in batches and returns one vector per text, in order', async () => {
    const { extractor, calls } = fakeExtractor();
    const { embedder } = embedderWith(extractor, { batchSize: 2 });

    const vectors = await embedder.embed(['a', 'b', 'c'], 'document');

    expect(calls.slice(1).map((call) => call.texts)).toEqual([['a', 'b'], ['c']]);
    expect(vectors).toEqual([
      [1, 0, 0, 0],
      [2, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
  });

  it('loads the model lazily, once, even with concurrent callers', async () => {
    const { extractor } = fakeExtractor();
    const { embedder, loadExtractor } = embedderWith(extractor);
    expect(embedder.state).toEqual({ status: 'idle' });

    const pending = Promise.all([embedder.load(), embedder.embed(['a'], 'document')]);
    expect(embedder.state).toEqual({ status: 'loading' });
    await pending;

    expect(loadExtractor).toHaveBeenCalledTimes(1);
    expect(loadExtractor).toHaveBeenCalledWith('Xenova/bge-small-en-v1.5', {
      cacheDir: '/tmp/models',
      dtype: 'fp32',
      allowRemoteModels: true,
    });
    expect(embedder.isReady()).toBe(true);
  });

  it('rejects a model whose vectors do not have the expected size', async () => {
    const { extractor } = fakeExtractor(8);
    const { embedder } = embedderWith(extractor);

    await expect(embedder.load()).rejects.toThrow('returned shape [1, 8], expected [1, 4]');
    expect(embedder.state.status).toBe('failed');
    expect(extractor.dispose).toHaveBeenCalled();
  });

  it('wraps load errors and retries on the next call', async () => {
    const { extractor } = fakeExtractor();
    const loadExtractor = vi
      .fn<ExtractorFactory>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(extractor);
    const embedder = new TransformersEmbedder({
      model: 'm',
      cacheDir: 'c',
      dimensions: 4,
      loadExtractor,
    });

    const failure = await embedder.load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmbeddingModelError);
    expect((failure as Error).cause).toEqual(new Error('network down'));

    await embedder.load();
    expect(embedder.isReady()).toBe(true);
  });

  it('returns no vectors for no texts without loading the model', async () => {
    const { extractor } = fakeExtractor();
    const { embedder, loadExtractor } = embedderWith(extractor);

    expect(await embedder.embed([], 'query')).toEqual([]);
    expect(loadExtractor).not.toHaveBeenCalled();
  });

  it('counts model tokens and releases the model on close', async () => {
    const { extractor } = fakeExtractor();
    const { embedder } = embedderWith(extractor);

    expect(await embedder.countTokens(['two words'])).toEqual([4]);
    await embedder.close();

    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(embedder.state).toEqual({ status: 'idle' });
    await embedder.close();
  });

  it('validates its options', () => {
    expect(() => new TransformersEmbedder({ model: ' ', cacheDir: 'c' })).toThrow(RangeError);
    expect(() => new TransformersEmbedder({ model: 'm', cacheDir: 'c', batchSize: 0 })).toThrow(
      RangeError,
    );
    expect(new TransformersEmbedder({ model: 'm', cacheDir: 'c' }).dimensions).toBe(384);
  });
});

describe('createEmbedderReadinessCheck', () => {
  const signal = new AbortController().signal;

  it.each([
    [{ status: 'ready' }, { status: 'pass' }],
    [{ status: 'loading' }, { status: 'fail', output: 'embedding model is loading' }],
    [{ status: 'idle' }, { status: 'fail', output: 'embedding model not loaded' }],
  ] as const)('maps %o to %o', async (state, outcome) => {
    const check = createEmbedderReadinessCheck({ model: 'm', state });

    expect(check.name).toBe('embedder');
    expect(await check.run(signal)).toEqual(outcome);
  });

  it('keeps the load error as internal detail', async () => {
    const error = new Error('boom');
    const check = createEmbedderReadinessCheck({ model: 'm', state: { status: 'failed', error } });

    expect(await check.run(signal)).toEqual({
      status: 'fail',
      output: 'embedding model failed to load',
      detail: error,
    });
  });
});
