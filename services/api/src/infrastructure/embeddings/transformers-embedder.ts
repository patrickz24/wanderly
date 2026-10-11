import type { CheckOutcome, ReadinessCheck } from '../../application/ports/readiness.js';
import type { Embedder, EmbeddingKind } from '../../domain/ports/knowledge.js';

/**
 * Local embeddings with Transformers.js (ONNX Runtime, CPU): no second API key, no network call
 * per request, deterministic output, so the retrieval evaluation runs in CI without secrets.
 *
 * Defaults follow the BAAI model card of bge-small-en-v1.5 (checked 2026-10-10):
 * - the sentence embedding is the last hidden state of the [CLS] token (`pooling: 'cls'`), then
 *   L2-normalized, so cosine distance and dot product agree. The Transformers.js example on the
 *   `Xenova/` mirror uses mean pooling instead; the retrieval evaluation compares both;
 * - short queries get the instruction "Represent this sentence for searching relevant passages: ";
 *   passages never do;
 * - 384 dimensions, 512 tokens at most (longer inputs are truncated by the tokenizer).
 */

export const BGE_QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

export type Pooling = 'cls' | 'mean';
export type ModelDtype = 'fp32' | 'fp16' | 'q8';

/** What the embedder needs from a feature-extraction pipeline (faked in unit tests). */
export interface FeatureExtractor {
  extract(
    texts: string[],
    options: { readonly pooling: Pooling; readonly normalize: boolean },
  ): Promise<{ readonly dims: readonly number[]; readonly data: ArrayLike<number> }>;
  /** Number of model tokens of a text, special tokens included (what truncation applies to). */
  countTokens(text: string): number;
  dispose(): Promise<void>;
}

export interface ExtractorLoadOptions {
  readonly cacheDir: string;
  readonly dtype: ModelDtype;
  readonly allowRemoteModels: boolean;
}

export type ExtractorFactory = (
  model: string,
  options: ExtractorLoadOptions,
) => Promise<FeatureExtractor>;

export interface TransformersEmbedderOptions {
  /** Hugging Face model id (`EMBEDDING_MODEL`), e.g. `Xenova/bge-small-en-v1.5`. */
  readonly model: string;
  /** Where downloaded model files are cached (`EMBEDDING_CACHE_DIR`). */
  readonly cacheDir: string;
  /** Expected vector size, checked when the model loads (the database column is vector(384)). */
  readonly dimensions?: number;
  readonly pooling?: Pooling;
  /** Prepended to queries, never to documents. Empty string to disable. */
  readonly queryPrefix?: string;
  readonly dtype?: ModelDtype;
  /** Texts per forward pass. */
  readonly batchSize?: number;
  /**
   * False forbids downloads: the model must already be in `cacheDir` (pre-baked images).
   * Defaults to true, unless the environment sets `HF_HUB_OFFLINE` (see {@link isHubOffline}).
   */
  readonly allowRemoteModels?: boolean;
  /** Where `HF_HUB_OFFLINE` is read from; defaults to `process.env` (injected in unit tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected in unit tests; defaults to the Transformers.js pipeline. */
  readonly loadExtractor?: ExtractorFactory;
}

export type EmbedderState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly error: unknown };

export class EmbeddingModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingModelError';
  }
}

export class TransformersEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly pooling: Pooling;
  readonly queryPrefix: string;
  readonly dtype: ModelDtype;
  readonly #batchSize: number;
  readonly #loadOptions: ExtractorLoadOptions;
  readonly #loadExtractor: ExtractorFactory;
  #loading: Promise<FeatureExtractor> | null = null;
  #state: EmbedderState = { status: 'idle' };

  constructor(options: TransformersEmbedderOptions) {
    if (options.model.trim() === '') throw new RangeError('model is required');
    this.model = options.model;
    this.dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.pooling = options.pooling ?? 'cls';
    this.queryPrefix = options.queryPrefix ?? BGE_QUERY_INSTRUCTION;
    this.dtype = options.dtype ?? 'fp32';
    this.#batchSize = options.batchSize ?? 32;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1) {
      throw new RangeError('batchSize must be a positive integer');
    }
    this.#loadOptions = {
      cacheDir: options.cacheDir,
      dtype: this.dtype,
      allowRemoteModels: options.allowRemoteModels ?? !isHubOffline(options.env ?? process.env),
    };
    this.#loadExtractor = options.loadExtractor ?? loadTransformersExtractor;
  }

  get state(): EmbedderState {
    return this.#state;
  }

  isReady(): boolean {
    return this.#state.status === 'ready';
  }

  /**
   * Loads the model once (concurrent callers share the same load) and checks its output size.
   * A failed load is not cached: the next call retries.
   */
  load(): Promise<void> {
    return this.#extractor().then(() => undefined);
  }

  async embed(texts: readonly string[], kind: EmbeddingKind): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.#extractor();
    const inputs = kind === 'query' ? texts.map((text) => this.queryPrefix + text) : [...texts];
    // A batch is padded to its longest text: batching texts of similar length (longest first)
    // avoids computing attention over padding. Results are put back in input order.
    const order = inputs
      .map((text, index) => ({ index, length: text.length }))
      .sort((left, right) => right.length - left.length || left.index - right.index)
      .map((entry) => entry.index);
    const vectors = new Array<number[]>(inputs.length);
    for (let start = 0; start < order.length; start += this.#batchSize) {
      const indexes = order.slice(start, start + this.#batchSize);
      const batch = indexes.map((index) => inputs[index] as string);
      const embedded = await this.#run(extractor, batch);
      indexes.forEach((index, position) => (vectors[index] = embedded[position] as number[]));
    }
    return vectors;
  }

  /** Model tokens per text, special tokens included (for diagnostics: truncation above 512). */
  async countTokens(texts: readonly string[]): Promise<number[]> {
    const extractor = await this.#extractor();
    return texts.map((text) => extractor.countTokens(text));
  }

  async close(): Promise<void> {
    const loading = this.#loading;
    this.#loading = null;
    this.#state = { status: 'idle' };
    if (loading !== null) await (await loading.catch(() => null))?.dispose();
  }

  #extractor(): Promise<FeatureExtractor> {
    if (this.#loading === null) {
      this.#state = { status: 'loading' };
      const loading = this.#loadAndVerify();
      this.#loading = loading;
      loading.then(
        () => {
          if (this.#loading === loading) this.#state = { status: 'ready' };
        },
        (error: unknown) => {
          if (this.#loading === loading) {
            this.#loading = null;
            this.#state = { status: 'failed', error };
          }
        },
      );
    }
    return this.#loading;
  }

  async #loadAndVerify(): Promise<FeatureExtractor> {
    let extractor: FeatureExtractor;
    try {
      extractor = await this.#loadExtractor(this.model, this.#loadOptions);
    } catch (error) {
      throw new EmbeddingModelError(`could not load embedding model ${this.model}`, {
        cause: error,
      });
    }
    try {
      await this.#run(extractor, ['dimension check']);
    } catch (error) {
      await extractor.dispose();
      throw error;
    }
    return extractor;
  }

  async #run(extractor: FeatureExtractor, batch: string[]): Promise<number[][]> {
    const output = await extractor.extract(batch, { pooling: this.pooling, normalize: true });
    const [rows, columns] = output.dims;
    if (output.dims.length !== 2 || rows !== batch.length || columns !== this.dimensions) {
      throw new EmbeddingModelError(
        `embedding model ${this.model} returned shape [${output.dims.join(', ')}], ` +
          `expected [${batch.length}, ${this.dimensions}]`,
      );
    }
    const vectors: number[][] = [];
    for (let row = 0; row < rows; row++) {
      vectors.push(sliceRow(output.data, row, columns));
    }
    return vectors;
  }
}

function sliceRow(data: ArrayLike<number>, row: number, columns: number): number[] {
  const values = new Array<number>(columns);
  for (let column = 0; column < columns; column++) {
    values[column] = data[row * columns + column] ?? Number.NaN;
  }
  return values;
}

/**
 * Hugging Face's offline switch (the `HF_HUB_OFFLINE` convention of huggingface_hub and
 * transformers, which Transformers.js itself does not read): `1`, `true`, `yes` or `on` means
 * "use the local cache only, never download". The API image sets it, since its model is baked in
 * at build time; the API, the ingestion CLI and the evaluations all honor it through this adapter.
 */
export function isHubOffline(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env['HF_HUB_OFFLINE']?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** `/ready` reports the model as a dependency: not ready until it is loaded and verified. */
export function createEmbedderReadinessCheck(embedder: {
  readonly model: string;
  readonly state: EmbedderState;
}): ReadinessCheck {
  return {
    name: 'embedder',
    async run(): Promise<CheckOutcome> {
      const state = embedder.state;
      switch (state.status) {
        case 'ready':
          return { status: 'pass' };
        case 'failed':
          return { status: 'fail', output: 'embedding model failed to load', detail: state.error };
        case 'loading':
          return { status: 'fail', output: 'embedding model is loading' };
        case 'idle':
          return { status: 'fail', output: 'embedding model not loaded' };
      }
    },
  };
}

/** The part of the Transformers.js global `env` that {@link alignTransformersEnv} sets. */
export interface TransformersGlobalEnv {
  cacheDir: string | null;
  allowRemoteModels: boolean;
}

/**
 * Transformers.js 4.3 resolves part of a pipeline load (the model config and the tokenizer file
 * lookups made by `pipeline()` itself) through its global `env` instead of the pipeline options:
 * left at their defaults, an offline load still calls huggingface.co and looks in another cache
 * directory. Setting the global cache and remote switch to the same values makes every lookup
 * agree. Process-wide by design: one embedding model per process (API, ingestion, evaluations).
 */
export function alignTransformersEnv(
  env: TransformersGlobalEnv,
  options: Pick<ExtractorLoadOptions, 'cacheDir' | 'allowRemoteModels'>,
): void {
  env.cacheDir = options.cacheDir;
  env.allowRemoteModels = options.allowRemoteModels;
}

/**
 * Default factory: the Transformers.js feature-extraction pipeline on ONNX Runtime CPU.
 * Imported lazily so that importing this module (and unit tests) never loads the native runtime.
 */
export const loadTransformersExtractor: ExtractorFactory = async (model, options) => {
  const { pipeline, env } = await import('@huggingface/transformers');
  alignTransformersEnv(env, options);
  const extractor = await pipeline('feature-extraction', model, {
    cache_dir: options.cacheDir,
    local_files_only: !options.allowRemoteModels,
    dtype: options.dtype,
    device: 'cpu',
  });
  return {
    async extract(texts, extractOptions) {
      const tensor = await extractor(texts, {
        pooling: extractOptions.pooling,
        normalize: extractOptions.normalize,
      });
      return { dims: tensor.dims, data: toNumbers(tensor.data) };
    },
    countTokens: (text) => extractor.tokenizer.encode(text).length,
    dispose: () => extractor.dispose(),
  };
};

function toNumbers(data: unknown): ArrayLike<number> {
  if (data instanceof Float32Array || data instanceof Float64Array) return data;
  throw new EmbeddingModelError('embedding model returned a non-float tensor');
}
