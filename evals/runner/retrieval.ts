/**
 * Retrieval evaluation: `npm run eval:retrieval -w @wanderly/evals [-- --write]`.
 *
 * For each chunking variant, the real corpus is ingested into a scratch database (created next to
 * DATABASE_URL, migrated, dropped at the end) with the production ingestion use case and the
 * real embedding model; then every query of evals/datasets/retrieval.yaml runs through the
 * production retriever with each strategy. Metrics are computed against section labels.
 *
 * Writes evals/results/<timestamp>/retrieval.json (gitignored, per-query detail). With --write,
 * also updates evals/baselines/retrieval.json (committed summary) and the results section of
 * docs/EVALUATIONS.md. Embeddings are cached in evals/results/.embedding-cache/ across runs.
 *
 * Environment: DATABASE_URL (a role allowed to CREATE DATABASE), EMBEDDING_MODEL,
 * EMBEDDING_CACHE_DIR (relative to the directory the command was started from).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runner as migrationRunner } from 'node-pg-migrate';
import pg from 'pg';
import { ingestCorpus } from '../../services/api/src/application/ingest-corpus.js';
import type { Corpus } from '../../services/api/src/application/ports/corpus-source.js';
import { DEFAULT_MIGRATIONS_DIR } from '../../services/api/src/infrastructure/db/migration-files.js';
import {
  DEFAULT_CHUNKING,
  markdownChunker,
  type DocumentChunker,
} from '../../services/api/src/domain/rag/chunker.js';
import {
  BGE_QUERY_INSTRUCTION,
  TransformersEmbedder,
} from '../../services/api/src/infrastructure/embeddings/transformers-embedder.js';
import { FsCorpusSource } from '../../services/api/src/infrastructure/knowledge/fs-corpus-source.js';
import type { FullTextMatch } from '../../services/api/src/infrastructure/knowledge/full-text-query.js';
import { PgKnowledgeStore } from '../../services/api/src/infrastructure/knowledge/pg-knowledge-store.js';
import {
  PgRetriever,
  type RetrievalStrategy,
} from '../../services/api/src/infrastructure/knowledge/pg-retriever.js';
import {
  median,
  renderTable,
  replaceBetweenMarkers,
  type ConfigurationSummary,
} from '../report/retrieval-report.js';
import {
  averageScores,
  bootstrapMeanInterval,
  firstRelevantRank,
  matchTargets,
  pairedDifferenceInterval,
  scoreQuery,
  type QueryScores,
} from '../scorers/retrieval-metrics.js';
import { CachingEmbedder } from './caching-embedder.js';
import { fixedSizeChunker } from './fixed-size-chunker.js';
import {
  findUnknownLabels,
  loadRetrievalDataset,
  type RetrievalCase,
} from './retrieval-dataset.js';

const EVALS_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_DIR = path.resolve(EVALS_DIR, '..');
const DATASET_FILE = path.join(EVALS_DIR, 'datasets', 'retrieval.yaml');
const RESULTS_DIR = path.join(EVALS_DIR, 'results');
const CACHE_FILE = path.join(RESULTS_DIR, '.embedding-cache', 'retrieval.jsonl');
const BASELINE_FILE = path.join(EVALS_DIR, 'baselines', 'retrieval.json');
const EVALUATIONS_DOC = path.join(REPO_DIR, 'docs', 'EVALUATIONS.md');
const LIMIT = 10;
const MODEL_MAX_TOKENS = 512;

interface Variant {
  readonly name: string;
  readonly chunker: DocumentChunker;
}

interface Strategy {
  readonly name: string;
  readonly strategy: RetrievalStrategy;
  readonly fullTextMatch: FullTextMatch;
}

const VARIANTS: readonly Variant[] = [
  { name: 'structure', chunker: markdownChunker(DEFAULT_CHUNKING) },
  { name: 'fixed-300', chunker: fixedSizeChunker({ sizeTokens: 300, overlapTokens: 40 }) },
];

const STRATEGIES: readonly Strategy[] = [
  { name: 'vector', strategy: 'vector', fullTextMatch: 'any' },
  { name: 'fulltext (all words)', strategy: 'fulltext', fullTextMatch: 'all' },
  { name: 'fulltext (any word)', strategy: 'fulltext', fullTextMatch: 'any' },
  { name: 'hybrid (all words)', strategy: 'hybrid', fullTextMatch: 'all' },
  { name: 'hybrid (any word)', strategy: 'hybrid', fullTextMatch: 'any' },
];

interface QueryResult {
  readonly id: string;
  readonly scores: QueryScores;
  readonly firstRelevantRank: number | null;
  readonly latencyMs: number;
  readonly top: readonly string[];
}

interface ConfigurationResult extends ConfigurationSummary {
  readonly chunkingFingerprint: string;
  readonly queries: readonly QueryResult[];
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } });
  const adminUrl = requireEnv('DATABASE_URL');
  const model = process.env['EMBEDDING_MODEL']?.trim() || 'Xenova/bge-small-en-v1.5';
  const cacheDir = path.resolve(
    process.env['INIT_CWD'] ?? process.cwd(),
    process.env['EMBEDDING_CACHE_DIR']?.trim() || '.cache/models',
  );

  const corpus = await new FsCorpusSource().load();
  const dataset = await loadRetrievalDataset(DATASET_FILE);
  const unknown = findUnknownLabels(dataset, corpus);
  if (unknown.length > 0) throw new Error(`Unknown labels:\n  ${unknown.join('\n  ')}`);

  const model_ = new TransformersEmbedder({ model, cacheDir });
  const loadStarted = performance.now();
  await model_.load();
  const loadMs = performance.now() - loadStarted;
  const rssAfterLoad = process.memoryUsage().rss;
  const embedder = new CachingEmbedder(
    model_,
    `pooling=${model_.pooling};prefix=${model_.queryPrefix === BGE_QUERY_INSTRUCTION ? 'bge' : JSON.stringify(model_.queryPrefix)};dtype=${model_.dtype}`,
  );
  let cached = await embedder.load(CACHE_FILE);
  const seedUrl = process.env['EVAL_SEED_DATABASE_URL']?.trim();
  if (seedUrl) cached += await seedCache(seedUrl, embedder, model);
  console.log(`Model ${model} loaded in ${(loadMs / 1000).toFixed(1)} s; ${cached} cached vectors`);
  console.log(`${dataset.queries.length} queries, ${documentCount(corpus)} documents`);

  const results: ConfigurationResult[] = [];
  const variantStats: Record<string, unknown> = {};
  for (const variant of VARIANTS) {
    const texts = chunkTexts(corpus, variant.chunker);
    const realTokens = await model_.countTokens(texts);
    const missesBefore = embedder.stats.misses;
    const scratch = await createScratchDatabase(adminUrl);
    const pool = new pg.Pool({ connectionString: scratch.url, max: 4 });
    try {
      const report = await ingestCorpus({
        source: { load: async () => corpus },
        store: new PgKnowledgeStore(pool),
        embedder,
        chunking: variant.chunker,
      });
      await embedder.save(CACHE_FILE);
      variantStats[variant.name] = {
        fingerprint: variant.chunker.fingerprint,
        chunks: report.chunks.written,
        ingestSeconds: Math.round(report.durationMs / 100) / 10,
        newlyEmbedded: embedder.stats.misses - missesBefore,
        meanModelTokens: Math.round(realTokens.reduce((a, b) => a + b, 0) / realTokens.length),
        overModelLimit: realTokens.filter((count) => count > MODEL_MAX_TOKENS).length,
      };
      console.log(`[${variant.name}]`, variantStats[variant.name]);
      for (const strategy of STRATEGIES) {
        const retriever = new PgRetriever(pool, embedder, {
          strategy: strategy.strategy,
          fullTextMatch: strategy.fullTextMatch,
        });
        const queries = [];
        for (const query of dataset.queries) queries.push(await runQuery(retriever, query));
        results.push(summarize(variant, strategy, report.chunks.written, queries));
      }
    } finally {
      await pool.end();
      await scratch.drop();
    }
  }
  await embedder.save(CACHE_FILE);

  const table = renderTable(results);
  const comparisons = compare(results);
  console.log(`\n${table}\n`);
  for (const line of comparisons) console.log(line);

  const run = {
    generatedAt: new Date().toISOString(),
    model,
    embedder: {
      pooling: model_.pooling,
      queryInstruction: model_.queryPrefix,
      dtype: model_.dtype,
    },
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: os.cpus().length,
      modelLoadSeconds: Math.round(loadMs / 100) / 10,
      rssAfterLoadMb: Math.round(rssAfterLoad / 1e6),
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1e3),
    },
    dataset: {
      queries: dataset.queries.length,
      withDestinationFilter: dataset.queries.filter((query) => query.destinationId !== null).length,
      provenance: [...new Set(dataset.queries.map((query) => query.provenance))],
    },
    limit: LIMIT,
    variants: variantStats,
    comparisons,
  };
  const stamp = run.generatedAt.replace(/[:.]/g, '-');
  const outDir = path.join(RESULTS_DIR, stamp);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'retrieval.json'),
    `${JSON.stringify({ ...run, configurations: results }, null, 2)}\n`,
  );
  console.log(`Wrote ${path.relative(REPO_DIR, path.join(outDir, 'retrieval.json'))}`);

  if (values.write) {
    const summary = results.map(({ queries: _queries, ...rest }) => rest);
    await writeFile(
      BASELINE_FILE,
      `${JSON.stringify({ ...run, configurations: summary }, null, 2)}\n`,
    );
    const doc = await readFile(EVALUATIONS_DOC, 'utf8');
    await writeFile(
      EVALUATIONS_DOC,
      replaceBetweenMarkers(doc, resultsSection(run, table, comparisons)),
    );
    console.log(`Updated ${path.relative(REPO_DIR, BASELINE_FILE)} and docs/EVALUATIONS.md`);
  }
}

async function runQuery(retriever: PgRetriever, query: RetrievalCase): Promise<QueryResult> {
  const started = performance.now();
  const retrieved = await retriever.searchDetailed({
    text: query.query,
    destinationId: query.destinationId,
    limit: LIMIT,
  });
  const latencyMs = performance.now() - started;
  return {
    id: query.id,
    scores: scoreQuery(retrieved, query.relevant),
    firstRelevantRank: firstRelevantRank(matchTargets(retrieved, query.relevant)),
    latencyMs: Math.round(latencyMs * 10) / 10,
    top: retrieved
      .slice(0, 5)
      .map((chunk) => `${chunk.documentPath}#${chunk.sections.join(' + ')}`),
  };
}

function summarize(
  variant: Variant,
  strategy: Strategy,
  chunks: number,
  queries: QueryResult[],
): ConfigurationResult {
  const scores = queries.map((query) => query.scores);
  return {
    chunking: variant.name,
    chunkingFingerprint: variant.chunker.fingerprint,
    strategy: strategy.name,
    chunks,
    metrics: averageScores(scores),
    intervals: {
      mrrAt10: bootstrapMeanInterval(scores.map((score) => score.mrrAt10)),
      recallAt5: bootstrapMeanInterval(scores.map((score) => score.recallAt5)),
    },
    medianLatencyMs: median(queries.map((query) => query.latencyMs)),
    queries,
  };
}

/** Paired differences on the same queries, for the decisions the ADRs record. */
function compare(results: readonly ConfigurationResult[]): string[] {
  const find = (chunking: string, strategy: string) =>
    results.find((result) => result.chunking === chunking && result.strategy === strategy);
  const pairs: Array<[string, string, string, string]> = [
    ['structure', 'hybrid (any word)', 'structure', 'vector'],
    ['structure', 'hybrid (any word)', 'structure', 'fulltext (any word)'],
    ['structure', 'hybrid (any word)', 'structure', 'hybrid (all words)'],
    ['structure', 'fulltext (any word)', 'structure', 'fulltext (all words)'],
    ['structure', 'hybrid (any word)', 'fixed-300', 'hybrid (any word)'],
    ['structure', 'vector', 'fixed-300', 'vector'],
  ];
  const lines: string[] = [];
  for (const [chunkingA, strategyA, chunkingB, strategyB] of pairs) {
    const a = find(chunkingA, strategyA);
    const b = find(chunkingB, strategyB);
    if (a === undefined || b === undefined) continue;
    for (const metric of ['mrrAt10', 'recallAt5'] as const) {
      const diff = pairedDifferenceInterval(
        a.queries.map((query) => query.scores[metric]),
        b.queries.map((query) => query.scores[metric]),
      );
      const points = (value: number) => (value * 100).toFixed(1);
      lines.push(
        `${chunkingA}/${strategyA} − ${chunkingB}/${strategyB}, ${metric}: ` +
          `${points(diff.mean)} points (95 % CI ${points(diff.low)} to ${points(diff.high)})`,
      );
    }
  }
  return lines;
}

function resultsSection(
  run: {
    generatedAt: string;
    model: string;
    dataset: { queries: number };
    variants: Record<string, unknown>;
  },
  table: string,
  comparisons: readonly string[],
): string {
  return [
    `Run of ${run.generatedAt.slice(0, 10)}, model \`${run.model}\`, ${run.dataset.queries} queries, top ${LIMIT}.`,
    'Metrics in %, with 95 % bootstrap intervals in parentheses. Generated by',
    '`npm run eval:retrieval -w @wanderly/evals -- --write`; do not edit by hand.',
    '',
    table,
    '',
    'Paired differences (same queries, 95 % bootstrap interval):',
    '',
    ...comparisons.map((line) => `- ${line}`),
    '',
    'Chunking variants:',
    '',
    '```json',
    JSON.stringify(run.variants, null, 2),
    '```',
  ].join('\n');
}

/**
 * Optional: reuse the vectors of a database already ingested with the default chunking and the
 * same model (EVAL_SEED_DATABASE_URL), instead of embedding the corpus again. With the contextual
 * header on, the embedded text is "<heading path>

<content>".
 */
async function seedCache(url: string, embedder: CachingEmbedder, model: string): Promise<number> {
  if (!DEFAULT_CHUNKING.contextualHeader) return 0;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{
      heading_path: string;
      content: string;
      embedding: string;
    }>(
      `SELECT c.heading_path, c.content, c.embedding::text AS embedding
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.chunking = $1 AND d.embedding_model = $2`,
      [markdownChunker(DEFAULT_CHUNKING).fingerprint, model],
    );
    for (const row of rows) {
      const vector: unknown = JSON.parse(row.embedding);
      if (Array.isArray(vector) && vector.every((value) => typeof value === 'number')) {
        embedder.remember(
          `${row.heading_path}

${row.content}`,
          'document',
          vector,
        );
      }
    }
    return rows.length;
  } finally {
    await client.end();
  }
}

function chunkTexts(corpus: Corpus, chunker: DocumentChunker): string[] {
  return corpus.destinations.flatMap((destination) =>
    destination.documents.flatMap((document) =>
      chunker
        .chunk({ title: document.breadcrumbRoot, markdown: document.body })
        .map((chunk) => chunk.text),
    ),
  );
}

function documentCount(corpus: Corpus): number {
  return corpus.destinations.reduce(
    (total, destination) => total + destination.documents.length,
    0,
  );
}

async function createScratchDatabase(
  adminUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `wanderly_eval_${randomBytes(6).toString('hex')}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  // `name` is generated above from hex characters only: safe to inline (identifiers cannot be bound).
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await migrationRunner({
    databaseUrl: url.toString(),
    dir: DEFAULT_MIGRATIONS_DIR,
    direction: 'up',
    count: Number.POSITIVE_INFINITY,
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  return { url: url.toString(), drop: () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
