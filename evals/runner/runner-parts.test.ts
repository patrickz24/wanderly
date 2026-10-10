import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Corpus } from '../../services/api/src/application/ports/corpus-source.js';
import type { Embedder } from '../../services/api/src/domain/ports/knowledge.js';
import { CachingEmbedder } from './caching-embedder.js';
import { fixedSizeChunker } from './fixed-size-chunker.js';
import { findUnknownLabels, parseRetrievalDataset } from './retrieval-dataset.js';

const DATASET = `
version: 1
queries:
  - id: etna-skiing
    query: Can you ski on Etna?
    destinationId: sicily
    style: question
    relevant:
      - { destinationId: sicily, document: guide.md, headingPath: Do > Skiing }
    provenance: proposed-by-agent, pending human review
`;

const corpus = {
  destinations: [
    {
      facts: { id: 'sicily' },
      factsAsOf: '2026-01-01',
      documents: [
        {
          path: 'sicily/guide.md',
          destinationId: 'sicily',
          role: 'region',
          title: 'Sicily',
          breadcrumbRoot: 'Sicily',
          sourceUrl: 'https://example.org',
          license: 'CC BY-SA 4.0',
          attribution: 'x',
          body: '# Sicily\n\n## Do\n\n### Skiing\n\nEtna has two ski stations.',
          checksum: 'x',
        },
      ],
    },
  ],
} as unknown as Corpus;

describe('retrieval dataset', () => {
  it('parses and validates the YAML', () => {
    const dataset = parseRetrievalDataset(DATASET);

    expect(dataset.queries[0]?.relevant[0]?.headingPath).toBe('Do > Skiing');
    expect(() => parseRetrievalDataset(DATASET.replace('question', 'riddle'))).toThrow();
    expect(() =>
      parseRetrievalDataset(DATASET + DATASET.split('queries:\n')[1]?.replace(/^/, '')),
    ).toThrow();
  });

  it('reports labels that name no section of the corpus', () => {
    const dataset = parseRetrievalDataset(DATASET);
    expect(findUnknownLabels(dataset, corpus)).toEqual([]);

    const typo = parseRetrievalDataset(DATASET.replace('Do > Skiing', 'Do > Skating'));
    expect(findUnknownLabels(typo, corpus)).toEqual([
      'etna-skiing: no section "Do > Skating" in sicily/guide.md',
    ]);
  });
});

describe('fixedSizeChunker', () => {
  const body = ['# Sicily', '## See', 'a b c d e f', '## Do', '### Hiking', 'g h i j'].join('\n');

  it('cuts fixed windows across sections, with overlap and no header', () => {
    const chunker = fixedSizeChunker({ sizeTokens: 5, overlapTokens: 2 });
    const chunks = chunker.chunk({ title: 'Sicily', markdown: body });

    expect(chunker.fingerprint).toBe('fixed-v1;size=5;overlap=2;header=off');
    expect(chunks[0]?.content).toBe('## See a b');
    expect(chunks[1]?.content.startsWith('a b')).toBe(true); // overlap of 2 tokens
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(5);
    expect(chunks.at(-1)?.content.endsWith('g h i j')).toBe(true);
    const spanning = chunks.find((chunk) => chunk.sections.length > 1);
    expect(spanning?.sections).toEqual(['See', 'Do']);
    expect(spanning?.headingPath).toBe('Sicily > See');
    expect(chunks.every((chunk) => chunk.text === chunk.content)).toBe(true);
  });

  it('validates its options', () => {
    expect(() => fixedSizeChunker({ sizeTokens: 0, overlapTokens: 0 })).toThrow(RangeError);
    expect(() => fixedSizeChunker({ sizeTokens: 5, overlapTokens: 5 })).toThrow(RangeError);
  });
});

describe('CachingEmbedder', () => {
  function counting(): Embedder & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      model: 'fake',
      dimensions: 2,
      calls,
      async embed(texts) {
        calls.push([...texts]);
        return texts.map((text) => [text.length, 1]);
      },
    };
  }

  it('embeds each distinct text once per kind and keeps the order', async () => {
    const inner = counting();
    const embedder = new CachingEmbedder(inner, 'cls');

    expect(await embedder.embed(['aa', 'b', 'aa'], 'document')).toEqual([
      [2, 1],
      [1, 1],
      [2, 1],
    ]);
    await embedder.embed(['b', 'ccc'], 'document');
    await embedder.embed(['b'], 'query');

    expect(inner.calls).toEqual([['aa', 'b'], ['ccc'], ['b']]);
    expect(embedder.stats).toEqual({ hits: 2, misses: 4, size: 4 });
  });

  it('persists the cache and reuses remembered vectors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wanderly-cache-'));
    const file = path.join(dir, 'cache.jsonl');
    try {
      const first = new CachingEmbedder(counting(), 'cls');
      first.remember('seeded', 'document', [9, 9]);
      await first.embed(['x'], 'query');
      await first.save(file);

      const inner = counting();
      const second = new CachingEmbedder(inner, 'cls');
      expect(await second.load(file)).toBe(2);
      expect(await second.embed(['seeded'], 'document')).toEqual([[9, 9]]);
      expect(inner.calls).toEqual([]);

      const otherConfig = new CachingEmbedder(counting(), 'mean');
      await otherConfig.load(file);
      await otherConfig.embed(['seeded'], 'document');
      expect(otherConfig.stats.misses).toBe(1);

      expect(await new CachingEmbedder(counting(), 'cls').load(path.join(dir, 'none'))).toBe(0);
      expect(() => first.remember('bad', 'document', [1])).toThrow(RangeError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
