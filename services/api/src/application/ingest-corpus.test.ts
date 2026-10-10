import type { Facts } from '@wanderly/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ChunkingOptions } from '../domain/rag/chunker.js';
import type { Embedder } from '../domain/ports/knowledge.js';
import { ingestCorpus, type IngestProgress } from './ingest-corpus.js';
import {
  CorpusValidationError,
  type Corpus,
  type CorpusDestination,
  type CorpusDocument,
} from './ports/corpus-source.js';
import type {
  DestinationSyncResult,
  DocumentToStore,
  IndexedDocument,
  KnowledgeStore,
} from './ports/knowledge-store.js';

const CHUNKING: ChunkingOptions = {
  targetTokens: 300,
  maxTokens: 450,
  overlapTokens: 30,
  minTokens: 40,
  contextualHeader: true,
};
const FINGERPRINT = 'md-v1;target=300;max=450;overlap=30;min=40;header=on';

function document(path: string, overrides: Partial<CorpusDocument> = {}): CorpusDocument {
  const destinationId = path.split('/')[0] ?? 'sicily';
  return {
    path,
    destinationId,
    role: path.includes('/places/') ? 'place' : 'region',
    title: 'Sicily',
    breadcrumbRoot: 'Sicily',
    sourceUrl: 'https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=1',
    license: 'CC BY-SA 4.0',
    attribution: '"Sicily" by Wikivoyage contributors',
    body: '## Do\n\n### Hiking\n\nMount Etna offers volcanic hikes with guides from Nicolosi.',
    checksum: `sha-${path}`,
    ...overrides,
  };
}

function destination(id: string, documents: CorpusDocument[]): CorpusDestination {
  return { facts: { id } as Facts, factsAsOf: '2026-07-31', documents };
}

class MemoryStore implements KnowledgeStore {
  readonly replaced: DocumentToStore[] = [];
  readonly removedPaths: string[][] = [];
  readonly synced: CorpusDestination[][] = [];

  constructor(public indexed: IndexedDocument[] = []) {}

  async syncDestinations(
    destinations: readonly CorpusDestination[],
  ): Promise<DestinationSyncResult> {
    this.synced.push([...destinations]);
    return { upserted: destinations.length, removed: ['old-destination'] };
  }

  async listIndexedDocuments(): Promise<readonly IndexedDocument[]> {
    return this.indexed;
  }

  async replaceDocument(input: DocumentToStore): Promise<void> {
    this.replaced.push(input);
  }

  async removeDocuments(paths: readonly string[]): Promise<void> {
    this.removedPaths.push([...paths]);
  }
}

function fakeEmbedder(dimensions = 3): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: 'fake-model',
    dimensions,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map(() => Array.from({ length: dimensions }, () => 0.5));
    },
  };
}

function setup(corpus: Corpus, indexed: IndexedDocument[] = []) {
  const store = new MemoryStore(indexed);
  const embedder = fakeEmbedder();
  let clock = 0;
  const run = (overrides: { force?: boolean; batchSize?: number } = {}) =>
    ingestCorpus({
      source: { load: async () => corpus },
      store,
      embedder,
      chunking: CHUNKING,
      now: () => (clock += 50),
      ...overrides,
    });
  return { store, embedder, run };
}

describe('ingestCorpus', () => {
  it('syncs the facts, chunks and embeds every new document, and reports it', async () => {
    const corpus = {
      destinations: [
        destination('sicily', [
          document('sicily/guide.md'),
          document('sicily/places/palermo.md', {
            title: 'Palermo',
            breadcrumbRoot: 'Sicily > Palermo',
          }),
        ]),
      ],
    };
    const { store, embedder, run } = setup(corpus);

    const report = await run();

    expect(store.synced).toEqual([corpus.destinations]);
    expect(store.replaced.map((input) => input.document.path)).toEqual([
      'sicily/guide.md',
      'sicily/places/palermo.md',
    ]);
    const [guide, place] = store.replaced;
    expect(guide?.embeddingModel).toBe('fake-model');
    expect(guide?.chunking).toBe(FINGERPRINT);
    expect(guide?.chunks).toEqual([
      {
        ordinal: 0,
        headingPath: 'Sicily > Do > Hiking',
        sections: ['Do > Hiking'],
        content: 'Mount Etna offers volcanic hikes with guides from Nicolosi.',
        tokenCount: expect.any(Number),
        embedding: [0.5, 0.5, 0.5],
      },
    ]);
    expect(place?.chunks[0]?.headingPath).toBe('Sicily > Palermo > Do > Hiking');
    // The embedded text carries the contextual header.
    expect(embedder.calls[0]?.[0]).toMatch(/^Sicily > Do > Hiking\n\nMount Etna/);
    expect(report).toEqual({
      destinations: { synced: 1, removed: ['old-destination'] },
      documents: { total: 2, indexed: 2, skipped: 0, removed: [] },
      chunks: { written: 2 },
      embeddingModel: 'fake-model',
      chunking: FINGERPRINT,
      durationMs: 50,
    });
  });

  it('skips documents whose checksum, model and chunking are unchanged', async () => {
    const guide = document('sicily/guide.md');
    const corpus = { destinations: [destination('sicily', [guide])] };
    const indexed = [
      {
        path: guide.path,
        checksum: guide.checksum,
        embeddingModel: 'fake-model',
        chunking: FINGERPRINT,
      },
    ];
    const { store, embedder, run } = setup(corpus, indexed);
    const progress: IngestProgress[] = [];

    const report = await ingestCorpus({
      source: { load: async () => corpus },
      store,
      embedder,
      chunking: CHUNKING,
      onProgress: (event) => progress.push(event),
    });

    expect(report.documents).toEqual({ total: 1, indexed: 0, skipped: 1, removed: [] });
    expect(store.replaced).toEqual([]);
    expect(embedder.calls).toEqual([]);
    expect(progress).toEqual([{ type: 'document.skipped', path: 'sicily/guide.md' }]);
    expect((await run({ force: true })).documents.indexed).toBe(1);
  });

  it.each([
    ['checksum', { checksum: 'changed' }],
    ['embedding model', { embeddingModel: 'other-model' }],
    ['chunking', { chunking: 'md-v0;other' }],
    ['unknown model (older rows)', { embeddingModel: null }],
  ])('re-indexes a document when its %s changed', async (_reason, change) => {
    const guide = document('sicily/guide.md');
    const stored = {
      path: guide.path,
      checksum: guide.checksum,
      embeddingModel: 'fake-model',
      chunking: FINGERPRINT,
      ...change,
    };
    const { store, run } = setup({ destinations: [destination('sicily', [guide])] }, [stored]);

    const report = await run();

    expect(report.documents.indexed).toBe(1);
    expect(store.replaced).toHaveLength(1);
  });

  it('removes indexed documents that left the corpus', async () => {
    const corpus = { destinations: [destination('sicily', [document('sicily/guide.md')])] };
    const stale = (path: string) => ({
      path,
      checksum: 'x',
      embeddingModel: 'fake-model',
      chunking: FINGERPRINT,
    });
    const { store, run } = setup(corpus, [stale('sicily/places/old.md'), stale('crete/guide.md')]);

    const report = await run();

    expect(store.removedPaths).toEqual([['crete/guide.md', 'sicily/places/old.md']]);
    expect(report.documents.removed).toEqual(['crete/guide.md', 'sicily/places/old.md']);
  });

  it('does not call removeDocuments when nothing is stale', async () => {
    const { store, run } = setup({
      destinations: [destination('sicily', [document('sicily/guide.md')])],
    });

    await run();

    expect(store.removedPaths).toEqual([]);
  });

  it('embeds chunks in batches as documents', async () => {
    const sections = Array.from(
      { length: 5 },
      (_, index) => `## Section ${index}\n\n${'word '.repeat(60)}`,
    ).join('\n\n');
    const corpus = {
      destinations: [destination('sicily', [document('sicily/guide.md', { body: sections })])],
    };
    const { embedder, run } = setup(corpus);
    const embed = vi.spyOn(embedder, 'embed');

    const report = await run({ batchSize: 2 });

    expect(report.chunks.written).toBe(5);
    expect(embedder.calls.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(embed).toHaveBeenCalledWith(expect.any(Array), 'document');
  });

  it('stores a document without chunks so that it is skipped next time', async () => {
    const corpus = {
      destinations: [destination('sicily', [document('sicily/guide.md', { body: '# Sicily\n' })])],
    };
    const { store, embedder, run } = setup(corpus);

    await run();

    expect(store.replaced[0]?.chunks).toEqual([]);
    expect(embedder.calls).toEqual([]);
  });

  it('fails when the embedder returns the wrong number or size of vectors', async () => {
    const corpus = { destinations: [destination('sicily', [document('sicily/guide.md')])] };
    const store = new MemoryStore();
    const base = { source: { load: async () => corpus }, store, chunking: CHUNKING };

    await expect(
      ingestCorpus({
        ...base,
        embedder: { model: 'm', dimensions: 3, embed: async () => [] },
      }),
    ).rejects.toThrow('embedder returned 0 vectors for 1 texts');
    await expect(
      ingestCorpus({
        ...base,
        embedder: { model: 'm', dimensions: 3, embed: async () => [[1, 2]] },
      }),
    ).rejects.toThrow('2-dimension vector, expected 3');
    expect(store.replaced).toEqual([]);
  });

  it('rejects an inconsistent corpus before writing anything', async () => {
    const corpus = {
      destinations: [
        destination('sicily', [document('sicily/places/palermo.md')]),
        destination('sicily', [document('crete/guide.md'), document('crete/guide.md')]),
      ],
    };
    const { store, run } = setup(corpus);

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CorpusValidationError);
    expect((error as CorpusValidationError).issues).toEqual([
      'destination "sicily" has no region guide',
      'destination "sicily" appears twice',
      'crete/guide.md: belongs to "crete", not "sicily"',
      'crete/guide.md: belongs to "crete", not "sicily"',
      'crete/guide.md: appears twice',
    ]);
    expect(store.synced).toEqual([]);
  });

  it('accepts another chunking strategy and stores its fingerprint', async () => {
    const corpus = { destinations: [destination('sicily', [document('sicily/guide.md')])] };
    const { store, embedder } = setup(corpus);

    await ingestCorpus({
      source: { load: async () => corpus },
      store,
      embedder,
      chunking: {
        fingerprint: 'whole-document',
        chunk: ({ title, markdown }) => [
          {
            ordinal: 0,
            headingPath: title,
            sections: [''],
            content: markdown,
            text: markdown,
            tokenCount: 1,
          },
        ],
      },
    });

    expect(store.replaced[0]?.chunking).toBe('whole-document');
    expect(store.replaced[0]?.chunks.map((chunk) => chunk.headingPath)).toEqual(['Sicily']);
  });

  it('validates its options before reading the corpus', async () => {
    const load = vi.fn(async (): Promise<Corpus> => ({ destinations: [] }));
    const deps = { source: { load }, store: new MemoryStore(), embedder: fakeEmbedder() };

    await expect(ingestCorpus({ ...deps, chunking: CHUNKING, batchSize: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      ingestCorpus({ ...deps, chunking: { ...CHUNKING, maxTokens: 10 } }),
    ).rejects.toThrow('maxTokens must be >= targetTokens');
    expect(load).not.toHaveBeenCalled();
  });
});
