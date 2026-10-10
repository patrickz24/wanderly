import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestCorpus } from '../../src/application/ingest-corpus.js';
import type { ChunkingOptions } from '../../src/domain/rag/chunker.js';
import { HashEmbedder } from '../../src/infrastructure/embeddings/hash-embedder.js';
import { PgKnowledgeRepository } from '../../src/infrastructure/knowledge/pg-knowledge-repository.js';
import { PgKnowledgeStore } from '../../src/infrastructure/knowledge/pg-knowledge-store.js';
import { PgRetriever } from '../../src/infrastructure/knowledge/pg-retriever.js';
import { createScratchDatabase, migrate, type ScratchDatabase } from './db.js';
import {
  CRETE_GUIDE,
  MutableCorpusSource,
  PALERMO_PLACE,
  SICILY_GUIDE,
  makeDestination,
  makeDocument,
  makeFacts,
} from './knowledge-fixtures.js';

/** One chunk per section: the fixtures are small, so nothing is merged or split. */
const CHUNKING: ChunkingOptions = {
  targetTokens: 300,
  maxTokens: 450,
  overlapTokens: 0,
  minTokens: 0,
  contextualHeader: true,
};

let scratch: ScratchDatabase;
let pool: pg.Pool;
const embedder = new HashEmbedder();

beforeAll(async () => {
  scratch = await createScratchDatabase();
  await migrate(scratch.url, 'up');
  pool = new pg.Pool({ connectionString: scratch.url, max: 4 });
});

afterAll(async () => {
  await pool?.end();
  await scratch?.drop();
});

async function reset(): Promise<void> {
  await pool.query('TRUNCATE destinations CASCADE');
}

function baseCorpus() {
  return {
    destinations: [
      makeDestination(makeFacts('crete'), [makeDocument('crete/guide.md', CRETE_GUIDE)]),
      makeDestination(makeFacts('sicily'), [
        makeDocument('sicily/guide.md', SICILY_GUIDE),
        makeDocument('sicily/places/palermo.md', PALERMO_PLACE, {
          title: 'Palermo',
          breadcrumbRoot: 'Sicily > Palermo',
        }),
      ]),
    ],
  };
}

function ingest(source: MutableCorpusSource) {
  return ingestCorpus({
    source,
    store: new PgKnowledgeStore(pool),
    embedder,
    chunking: CHUNKING,
  });
}

async function chunkIdsByDocument(): Promise<Record<string, string[]>> {
  const { rows } = await pool.query<{ source_path: string; ids: string[] }>(
    `SELECT d.source_path, array_agg(c.id ORDER BY c.ordinal) AS ids
     FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
     GROUP BY d.source_path ORDER BY d.source_path`,
  );
  return Object.fromEntries(rows.map((row) => [row.source_path, row.ids]));
}

describe('corpus ingestion into Postgres', () => {
  beforeEach(reset);

  it('writes destinations, facts, documents and chunks with their breadcrumbs', async () => {
    const report = await ingest(new MutableCorpusSource(baseCorpus()));

    expect(report.documents).toEqual({ total: 3, indexed: 3, skipped: 0, removed: [] });
    expect(report.chunks.written).toBe(10);
    const { rows } = await pool.query<{
      source_path: string;
      role: string;
      heading_path: string;
      section_paths: string[];
      embedding_model: string;
      dims: number;
    }>(
      `SELECT d.source_path, d.role, c.heading_path, c.section_paths, d.embedding_model,
              vector_dims(c.embedding) AS dims
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.destination_id = 'sicily' ORDER BY d.source_path, c.ordinal`,
    );
    expect(
      rows.map((row) => [row.source_path, row.role, row.heading_path, row.section_paths]),
    ).toEqual([
      ['sicily/guide.md', 'region', 'Sicily > Overview', ['Overview']],
      ['sicily/guide.md', 'region', 'Sicily > See > Archaeology', ['See > Archaeology']],
      ['sicily/guide.md', 'region', 'Sicily > Do > Hiking', ['Do > Hiking']],
      ['sicily/guide.md', 'region', 'Sicily > Do > Beaches', ['Do > Beaches']],
      ['sicily/guide.md', 'region', 'Sicily > Eat', ['Eat']],
      ['sicily/places/palermo.md', 'place', 'Sicily > Palermo > See', ['See']],
    ]);
    expect(new Set(rows.map((row) => row.embedding_model))).toEqual(new Set(['hash-bow-384']));
    expect(new Set(rows.map((row) => row.dims))).toEqual(new Set([384]));
  });

  it('is idempotent: a second run skips every unchanged document and keeps the chunks', async () => {
    const source = new MutableCorpusSource(baseCorpus());
    await ingest(source);
    const before = await chunkIdsByDocument();

    const report = await ingest(source);

    expect(report.documents).toEqual({ total: 3, indexed: 0, skipped: 3, removed: [] });
    expect(report.chunks.written).toBe(0);
    expect(await chunkIdsByDocument()).toEqual(before);
  });

  it('re-indexes only a changed document, and removes documents and destinations that left', async () => {
    const source = new MutableCorpusSource(baseCorpus());
    await ingest(source);
    const before = await chunkIdsByDocument();

    const changedGuide = `${SICILY_GUIDE}\n\n## Stay safe\n\nWatch for pickpockets in Palermo markets.`;
    source.corpus = {
      destinations: [
        makeDestination(makeFacts('sicily'), [makeDocument('sicily/guide.md', changedGuide)]),
      ],
    };
    const report = await ingest(source);

    expect(report.destinations.removed).toEqual(['crete']);
    expect(report.documents).toEqual({
      total: 1,
      indexed: 1,
      skipped: 0,
      removed: ['sicily/places/palermo.md'],
    });
    const after = await chunkIdsByDocument();
    expect(Object.keys(after)).toEqual(['sicily/guide.md']);
    expect(after['sicily/guide.md']).toHaveLength(6);
    expect(after['sicily/guide.md']).not.toEqual(before['sicily/guide.md']);
    const counts = await pool.query<{ destinations: number; pois: number; climate: number }>(
      `SELECT (SELECT count(*)::int FROM destinations) AS destinations,
              (SELECT count(*)::int FROM climate_normals) AS climate,
              (SELECT count(*)::int FROM pois) AS pois`,
    );
    expect(counts.rows[0]).toEqual({ destinations: 1, climate: 12, pois: 0 });
  });

  it('re-indexes everything when the chunking changes', async () => {
    const source = new MutableCorpusSource(baseCorpus());
    await ingest(source);

    const report = await ingestCorpus({
      source,
      store: new PgKnowledgeStore(pool),
      embedder,
      chunking: { ...CHUNKING, minTokens: 60 },
    });

    expect(report.documents.indexed).toBe(3);
    const { rows } = await pool.query<{ heading_path: string; section_paths: string[] }>(
      `SELECT heading_path, section_paths FROM chunks WHERE destination_id = 'crete' ORDER BY ordinal`,
    );
    expect(rows).toContainEqual({
      heading_path: 'Crete > Do',
      section_paths: ['Do > Hiking', 'Do > Beaches'],
    });
  });

  it('replaces a document atomically: a failed write keeps the previous version', async () => {
    const source = new MutableCorpusSource(baseCorpus());
    await ingest(source);
    const before = await chunkIdsByDocument();
    const store = new PgKnowledgeStore(pool);
    const document = makeDocument('crete/guide.md', 'changed', { checksum: 'new' });

    await expect(
      store.replaceDocument({
        document,
        embeddingModel: 'hash-bow-384',
        chunking: 'test',
        chunks: [
          {
            ordinal: 0,
            headingPath: 'Crete',
            sections: [''],
            content: 'ok',
            tokenCount: 1,
            embedding: Array<number>(384).fill(0.1),
          },
          {
            ordinal: 1,
            headingPath: 'Crete',
            sections: [''],
            content: 'bad',
            tokenCount: 1,
            embedding: [1, 2, 3],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: '22000' });

    expect(await chunkIdsByDocument()).toEqual(before);
  });
});

describe('PgRetriever', () => {
  beforeAll(async () => {
    await reset();
    await ingest(new MutableCorpusSource(baseCorpus()));
  });

  const search = (
    text: string,
    options: ConstructorParameters<typeof PgRetriever>[2] = {},
    destinationId: string | null = null,
    limit = 5,
  ) => new PgRetriever(pool, embedder, options).searchDetailed({ text, destinationId, limit });

  it('fuses the vector and full-text lists and reports the rank in each', async () => {
    const results = await search('Etna volcanic hikes summit', { strategy: 'hybrid' });

    expect(results[0]).toMatchObject({
      headingPath: 'Sicily > Do > Hiking',
      documentTitle: 'Sicily',
      documentPath: 'sicily/guide.md',
      sections: ['Do > Hiking'],
      sourceUrl: 'https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=1',
      ranks: { vector: 1, fullText: 1 },
    });
    expect(results[0]?.score).toBeCloseTo(2 / 61, 10);
    const scores = results.map((result) => result.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it('runs a single list for the vector and full-text strategies', async () => {
    const vector = await search('Etna volcanic hikes summit', { strategy: 'vector' });
    const fullText = await search('Etna volcanic hikes summit', { strategy: 'fulltext' });

    expect(vector.every((result) => result.ranks.fullText === null)).toBe(true);
    expect(vector.map((result) => result.ranks.vector)).toEqual([1, 2, 3, 4, 5]);
    expect(fullText.every((result) => result.ranks.vector === null)).toBe(true);
    expect(fullText[0]?.headingPath).toBe('Sicily > Do > Hiking');
  });

  it('matches all words or any word depending on the full-text mode', async () => {
    const question = 'which island has a gorge hike and pink sand';

    const all = await search(question, { strategy: 'fulltext', fullTextMatch: 'all' });
    const any = await search(question, { strategy: 'fulltext', fullTextMatch: 'any' });

    expect(all).toEqual([]);
    const paths = any.map((result) => result.headingPath);
    expect(paths[0]).toBe('Crete > Do > Hiking'); // "gorge" and "hike"
    expect(paths).toContain('Crete > Do > Beaches'); // "pink" and "sand"
  });

  it('filters by destination', async () => {
    const results = await search('beaches', {}, 'crete');

    expect(results.length).toBeGreaterThan(0);
    expect(new Set(results.map((result) => result.destinationId))).toEqual(new Set(['crete']));
    expect(results.slice(0, 2).map((result) => result.headingPath)).toContain(
      'Crete > Do > Beaches',
    );
  });

  it('respects the limit and returns nothing for a blank query', async () => {
    expect(await search('the island', { strategy: 'vector' }, null, 2)).toHaveLength(2);
    expect(await search('   ')).toEqual([]);
    await expect(search('etna', {}, null, 0)).rejects.toThrow(RangeError);
    await expect(search('etna', {}, null, 51)).rejects.toThrow(RangeError);
  });

  it('exposes the port shape through search()', async () => {
    const [first] = await new PgRetriever(pool, embedder).search({
      text: 'Samaria Gorge',
      destinationId: null,
      limit: 1,
    });

    expect(Object.keys(first ?? {}).sort()).toEqual([
      'content',
      'destinationId',
      'documentTitle',
      'headingPath',
      'id',
      'ranks',
      'score',
      'sourceUrl',
    ]);
    expect(first?.content).toContain('Samaria Gorge');
  });
});

describe('PgRetriever with a destination filter on a large index', () => {
  it('still returns the requested number of chunks when other destinations are closer', async () => {
    await reset();
    // 300 chunks of "crete" close to the query, 6 chunks of "malta" far from it: a plain HNSW
    // scan would fill ef_search with crete chunks and the filter would leave fewer than 6.
    const many = Array.from(
      { length: 300 },
      (_, index) => `## Beach ${index}\n\nsandy beach sun swim ${index}`,
    );
    const few = Array.from(
      { length: 6 },
      (_, index) => `## Fort ${index}\n\nold fort walls ${index}`,
    );
    await ingest(
      new MutableCorpusSource({
        destinations: [
          makeDestination(makeFacts('crete'), [makeDocument('crete/guide.md', many.join('\n\n'))]),
          makeDestination(makeFacts('malta'), [makeDocument('malta/guide.md', few.join('\n\n'))]),
        ],
      }),
    );

    const results = await new PgRetriever(pool, embedder, {
      strategy: 'vector',
    }).searchDetailed({ text: 'sandy beach sun swim', destinationId: 'malta', limit: 6 });

    expect(results).toHaveLength(6);
    expect(new Set(results.map((result) => result.destinationId))).toEqual(new Set(['malta']));
  });
});

describe('PgKnowledgeRepository', () => {
  const repository = () => new PgKnowledgeRepository(pool);

  beforeAll(async () => {
    await reset();
    const lodging = {
      median: 28.5,
      min: 12,
      max: 90,
      currency: '€',
      sample_size: 6,
      excluded_other_currency: 1,
    };
    const facts = makeFacts('hvar', {
      name: 'Hvar',
      aliases: ['Hvar Island', 'Lesina'],
      costs: {
        derivation: 'medians of listing prices',
        overall: { lodging_night: lodging, meal: null, notes: ['meal: no priced listing'] },
        levels: {
          budget: { lodging_night: null, meal: null, notes: [] },
          mid: { lodging_night: null, meal: null, notes: [] },
          comfort: { lodging_night: null, meal: null, notes: ['no Splurge subsection'] },
        },
      },
      pois: [
        {
          id: 'hvar-fortress',
          name: 'Fortress',
          kinds: ['historic_site', 'viewpoint'],
          description: 'Spanish fortress.',
          crowd_level: 4,
          best_months: [],
          source_ref: 'Hvar > See',
        },
        {
          id: 'hvar-beach',
          name: 'Dubovica',
          kinds: ['beach'],
          description: null,
          crowd_level: null,
          best_months: [7, 8],
          source_ref: 'Hvar > Do',
        },
        {
          id: 'hvar-hike',
          name: 'Sveti Nikola',
          kinds: ['hiking', 'viewpoint'],
          description: 'Highest peak.',
          crowd_level: 1,
          best_months: [5],
          source_ref: 'Hvar > Do > Hiking',
        },
        {
          id: 'hvar-crowded',
          name: 'Town square',
          kinds: ['historic_site'],
          description: null,
          crowd_level: 5,
          best_months: [8],
          source_ref: 'Hvar > See',
        },
      ],
    });
    await ingest(
      new MutableCorpusSource({
        destinations: [
          makeDestination(
            facts,
            [makeDocument('hvar/guide.md', '## See\n\nThe fortress.')],
            '2025-05-01',
          ),
          makeDestination(makeFacts('azores'), [
            makeDocument('azores/guide.md', '## Do\n\nWhales.'),
          ]),
        ],
      }),
    );
  });

  it('lists destinations with their aliases, by name', async () => {
    expect(await repository().listDestinations()).toEqual([
      { id: 'azores', name: 'Azores', country: 'Testland', aliases: ['Azores-alias'] },
      { id: 'hvar', name: 'Hvar', country: 'Testland', aliases: ['Hvar Island', 'Lesina'] },
    ]);
  });

  it('returns the climate of a month with its attribution', async () => {
    expect(await repository().getClimate('hvar', 5)).toEqual({
      destinationId: 'hvar',
      month: 5,
      avgHighC: 14,
      avgLowC: 7,
      rainDays: 3.5,
      precipitationMm: 40.2,
      attribution: 'Weather data by Open-Meteo.com',
    });
    expect(await repository().getClimate('atlantis', 5)).toBeNull();
    await expect(repository().getClimate('hvar', 13)).rejects.toThrow(RangeError);
  });

  it('returns cost figures per level, unknown figures as null', async () => {
    const costs = await repository().getCosts('hvar');

    expect(costs).toEqual({
      destinationId: 'hvar',
      derivation: 'medians of listing prices',
      overall: {
        lodgingNight: { median: 28.5, min: 12, max: 90, currency: '€', sampleSize: 6 },
        meal: null,
        notes: ['meal: no priced listing'],
      },
      levels: {
        budget: { lodgingNight: null, meal: null, notes: [] },
        mid: { lodgingNight: null, meal: null, notes: [] },
        comfort: { lodgingNight: null, meal: null, notes: ['no Splurge subsection'] },
      },
    });
    expect(await repository().getCosts('atlantis')).toBeNull();
    const asOf = await pool.query<{ as_of: string }>(
      `SELECT to_char(as_of, 'YYYY-MM-DD') AS as_of FROM cost_profiles WHERE destination_id = 'hvar' LIMIT 1`,
    );
    expect(asOf.rows[0]?.as_of).toBe('2025-05-01');
  });

  const pois = (query: Partial<Parameters<PgKnowledgeRepository['searchPois']>[0]> = {}) =>
    repository().searchPois({
      destinationId: 'hvar',
      kinds: [],
      maxCrowdLevel: null,
      month: null,
      limit: 10,
      ...query,
    });

  it('returns POIs in corpus order by default', async () => {
    const results = await pois();

    expect(results.map((poi) => poi.id)).toEqual([
      'hvar-fortress',
      'hvar-beach',
      'hvar-hike',
      'hvar-crowded',
    ]);
    expect(results[1]).toEqual({
      id: 'hvar-beach',
      destinationId: 'hvar',
      name: 'Dubovica',
      kinds: ['beach'],
      description: null,
      crowdLevel: null,
      bestMonths: [7, 8],
      sourceRef: 'Hvar > Do',
    });
  });

  it('filters by any of the kinds', async () => {
    const results = await pois({ kinds: ['viewpoint', 'beach'] });

    expect(results.map((poi) => poi.id)).toEqual(['hvar-fortress', 'hvar-beach', 'hvar-hike']);
  });

  it('drops POIs known to be too crowded but keeps those with an unknown crowd level', async () => {
    const results = await pois({ maxCrowdLevel: 3 });

    expect(results.map((poi) => poi.id)).toEqual(['hvar-beach', 'hvar-hike']);
  });

  it('puts POIs recommended for the month first, without filtering the others', async () => {
    const results = await pois({ month: 8 });

    expect(results.map((poi) => poi.id)).toEqual([
      'hvar-beach',
      'hvar-crowded',
      'hvar-fortress',
      'hvar-hike',
    ]);
  });

  it('applies the limit and validates the query', async () => {
    expect(await pois({ limit: 1 })).toHaveLength(1);
    expect(await pois({ destinationId: 'atlantis' })).toEqual([]);
    await expect(pois({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(pois({ month: 0 })).rejects.toThrow(RangeError);
    await expect(pois({ maxCrowdLevel: 6 })).rejects.toThrow(RangeError);
  });
});
