import {
  chunkMarkdown,
  chunkingFingerprint,
  validateChunkingOptions,
  type Chunk,
  type ChunkingOptions,
} from '../domain/rag/chunker.js';
import type { Embedder } from '../domain/ports/knowledge.js';
import {
  CorpusValidationError,
  type Corpus,
  type CorpusDocument,
  type CorpusSource,
} from './ports/corpus-source.js';
import type { ChunkToStore, IndexedDocument, KnowledgeStore } from './ports/knowledge-store.js';

export interface IngestCorpusDeps {
  readonly source: CorpusSource;
  readonly store: KnowledgeStore;
  readonly embedder: Embedder;
  readonly chunking: ChunkingOptions;
  /** Chunks embedded per call to the embedder. */
  readonly batchSize?: number;
  /** Re-index every document, even unchanged ones. */
  readonly force?: boolean;
  /** Monotonic clock in milliseconds (injected in tests). */
  readonly now?: () => number;
  readonly onProgress?: (event: IngestProgress) => void;
}

export type IngestProgress =
  | { readonly type: 'document.indexed'; readonly path: string; readonly chunks: number }
  | { readonly type: 'document.skipped'; readonly path: string };

export interface IngestReport {
  readonly destinations: { readonly synced: number; readonly removed: readonly string[] };
  readonly documents: {
    readonly total: number;
    readonly indexed: number;
    readonly skipped: number;
    readonly removed: readonly string[];
  };
  readonly chunks: { readonly written: number };
  readonly embeddingModel: string;
  readonly chunking: string;
  readonly durationMs: number;
}

export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;

/**
 * Use case: makes the knowledge base equal to the corpus.
 *
 * validate → upsert destinations and facts → for each document whose checksum, embedding model
 * or chunking changed: chunk → embed in batches → replace the document and its chunks in one
 * transaction → delete documents no longer in the corpus. Running it twice in a row indexes
 * nothing the second time. Embedding happens before the write transaction opens, so a slow model
 * never holds database locks.
 */
export async function ingestCorpus(deps: IngestCorpusDeps): Promise<IngestReport> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const batchSize = deps.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  const chunking = chunkingFingerprint(validateChunkingOptions(deps.chunking));
  const embeddingModel = deps.embedder.model;

  const corpus = await deps.source.load();
  assertConsistent(corpus);

  const synced = await deps.store.syncDestinations(corpus.destinations);
  const indexed = new Map(
    (await deps.store.listIndexedDocuments()).map((document) => [document.path, document]),
  );

  const documents = corpus.destinations
    .flatMap((destination) => destination.documents)
    .sort((left, right) => compareStrings(left.path, right.path));

  let indexedCount = 0;
  let skipped = 0;
  let written = 0;
  for (const document of documents) {
    if (!deps.force && isUpToDate(indexed.get(document.path), document, embeddingModel, chunking)) {
      skipped += 1;
      deps.onProgress?.({ type: 'document.skipped', path: document.path });
      continue;
    }
    const chunks = chunkMarkdown(
      { title: document.breadcrumbRoot, markdown: document.body },
      deps.chunking,
    );
    const embeddings = await embedInBatches(deps.embedder, chunks, batchSize);
    await deps.store.replaceDocument({
      document,
      embeddingModel,
      chunking,
      chunks: chunks.map((chunk, index): ChunkToStore => ({
        ordinal: chunk.ordinal,
        headingPath: chunk.headingPath,
        sections: chunk.sections,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: embeddings[index] ?? [],
      })),
    });
    indexedCount += 1;
    written += chunks.length;
    deps.onProgress?.({ type: 'document.indexed', path: document.path, chunks: chunks.length });
  }

  const current = new Set(documents.map((document) => document.path));
  const stale = [...indexed.keys()].filter((path) => !current.has(path)).sort(compareStrings);
  if (stale.length > 0) await deps.store.removeDocuments(stale);

  return {
    destinations: { synced: synced.upserted, removed: synced.removed },
    documents: { total: documents.length, indexed: indexedCount, skipped, removed: stale },
    chunks: { written },
    embeddingModel,
    chunking,
    durationMs: Math.round(now() - startedAt),
  };
}

function isUpToDate(
  stored: IndexedDocument | undefined,
  document: CorpusDocument,
  embeddingModel: string,
  chunking: string,
): boolean {
  return (
    stored !== undefined &&
    stored.checksum === document.checksum &&
    stored.embeddingModel === embeddingModel &&
    stored.chunking === chunking
  );
}

async function embedInBatches(
  embedder: Embedder,
  chunks: readonly Chunk[],
  batchSize: number,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize).map((chunk) => chunk.text);
    const embedded = await embedder.embed(batch, 'document');
    if (embedded.length !== batch.length) {
      throw new Error(`embedder returned ${embedded.length} vectors for ${batch.length} texts`);
    }
    for (const vector of embedded) {
      if (vector.length !== embedder.dimensions) {
        throw new Error(
          `embedder returned a ${vector.length}-dimension vector, expected ${embedder.dimensions}`,
        );
      }
      vectors.push([...vector]);
    }
  }
  return vectors;
}

/** Cross-file rules the per-file schemas cannot check. */
function assertConsistent(corpus: Corpus): void {
  const issues: string[] = [];
  const destinationIds = new Set<string>();
  const paths = new Set<string>();
  for (const destination of corpus.destinations) {
    const id = destination.facts.id;
    if (destinationIds.has(id)) issues.push(`destination "${id}" appears twice`);
    destinationIds.add(id);
    if (destination.documents[0]?.role !== 'region') {
      issues.push(`destination "${id}" has no region guide`);
    }
    for (const document of destination.documents) {
      if (document.destinationId !== id) {
        issues.push(`${document.path}: belongs to "${document.destinationId}", not "${id}"`);
      }
      if (paths.has(document.path)) issues.push(`${document.path}: appears twice`);
      paths.add(document.path);
    }
  }
  if (issues.length > 0) throw new CorpusValidationError(issues);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
