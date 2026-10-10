/**
 * Ingests the destination corpus into Postgres: `npm run ingest -w @wanderly/api`
 * (or `node dist/cli/ingest.js` in the API image).
 *
 *   --corpus <dir>   corpus root (default: the repository's data/corpus)
 *   --force          re-index every document, even unchanged ones
 *
 * Reads DATABASE_URL, EMBEDDING_MODEL and EMBEDDING_CACHE_DIR only: ingestion must not need the
 * API's secrets (session secret, LLM keys). A relative cache dir is resolved from the directory
 * the command was started in (npm's INIT_CWD), so every workspace shares one model cache.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ingestCorpus, type IngestReport } from '../application/ingest-corpus.js';
import { CorpusValidationError } from '../application/ports/corpus-source.js';
import { Secret } from '../config.js';
import { DEFAULT_CHUNKING } from '../domain/rag/chunker.js';
import { createPool } from '../infrastructure/db/pool.js';
import { TransformersEmbedder } from '../infrastructure/embeddings/transformers-embedder.js';
import {
  DEFAULT_CORPUS_DIR,
  FsCorpusSource,
} from '../infrastructure/knowledge/fs-corpus-source.js';
import { PgKnowledgeStore } from '../infrastructure/knowledge/pg-knowledge-store.js';

export interface IngestCliOptions {
  readonly corpusDir: string;
  readonly force: boolean;
}

export function parseIngestArgs(argv: readonly string[]): IngestCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { corpus: { type: 'string' }, force: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });
  return { corpusDir: path.resolve(values.corpus ?? DEFAULT_CORPUS_DIR), force: values.force };
}

const IngestEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'is required' })
    .trim()
    .refine((value) => /^postgres(ql)?:\/\/./.test(value), 'must be a postgres:// URL'),
  EMBEDDING_MODEL: z.string().trim().min(1).default('Xenova/bge-small-en-v1.5'),
  EMBEDDING_CACHE_DIR: z.string().trim().min(1).default('.cache/models'),
});

export interface IngestEnv {
  readonly databaseUrl: Secret;
  readonly embeddingModel: string;
  readonly embeddingCacheDir: string;
}

/** Validates the variables ingestion needs; messages name variables, never their values. */
export function readIngestEnv(env: Readonly<Record<string, string | undefined>>): IngestEnv {
  const blankAsUnset = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = IngestEnvSchema.safeParse(blankAsUnset);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  - ${issues.join('\n  - ')}`);
  }
  const base = env['INIT_CWD'] ?? process.cwd();
  return {
    databaseUrl: new Secret(result.data.DATABASE_URL),
    embeddingModel: result.data.EMBEDDING_MODEL,
    embeddingCacheDir: path.resolve(base, result.data.EMBEDDING_CACHE_DIR),
  };
}

export function formatReport(report: IngestReport): string {
  const { destinations, documents, chunks } = report;
  const removed = (items: readonly string[]) =>
    items.length === 0 ? '0 removed' : `${items.length} removed (${items.join(', ')})`;
  return [
    `Embedding model  ${report.embeddingModel}`,
    `Chunking         ${report.chunking}`,
    `Destinations     ${destinations.synced} synced, ${removed(destinations.removed)}`,
    `Documents        ${documents.total} in corpus: ${documents.indexed} indexed, ` +
      `${documents.skipped} skipped (unchanged), ${removed(documents.removed)}`,
    `Chunks           ${chunks.written} written`,
    `Duration         ${(report.durationMs / 1000).toFixed(1)} s`,
  ].join('\n');
}

/** Only one ingestion at a time: concurrent runs would race on the same documents. */
const INGEST_LOCK_KEY = 'wanderly.ingest';

async function main(): Promise<void> {
  const options = parseIngestArgs(process.argv.slice(2));
  const env = readIngestEnv(process.env);

  const pool = createPool({
    url: env.databaseUrl,
    onIdleClientError: (error) => console.error('idle Postgres client error:', error.message),
    max: 4,
  });
  const embedder = new TransformersEmbedder({
    model: env.embeddingModel,
    cacheDir: env.embeddingCacheDir,
  });
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [INGEST_LOCK_KEY],
    );
    if (rows[0]?.locked !== true) {
      throw new Error('another ingestion is running on this database');
    }
    console.log(`Ingesting ${options.corpusDir}`);
    const store = new PgKnowledgeStore(pool);
    const report = await ingestCorpus({
      source: new FsCorpusSource(options.corpusDir),
      store,
      embedder,
      chunking: DEFAULT_CHUNKING,
      force: options.force,
      onProgress: (event) => {
        if (event.type === 'document.indexed') {
          console.log(`  indexed ${event.path} (${event.chunks} chunks)`);
        }
      },
    });
    if (report.documents.indexed > 0 || report.documents.removed.length > 0) await store.analyze();
    console.log(formatReport(report));
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext($1))`, [INGEST_LOCK_KEY]).catch(() => {});
    lock.release();
    await embedder.close();
    await pool.end();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    if (error instanceof CorpusValidationError) console.error(error.message);
    else console.error('Ingestion failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
