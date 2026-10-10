import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CORPUS_DIR } from '../infrastructure/knowledge/fs-corpus-source.js';
import { formatReport, parseIngestArgs, readIngestEnv } from './ingest.js';

describe('parseIngestArgs', () => {
  it('defaults to the repository corpus without forcing', () => {
    expect(parseIngestArgs([])).toEqual({
      corpusDir: path.resolve(DEFAULT_CORPUS_DIR),
      force: false,
    });
  });

  it('accepts --corpus and --force', () => {
    expect(parseIngestArgs(['--corpus', 'fixtures/corpus', '--force'])).toEqual({
      corpusDir: path.resolve('fixtures/corpus'),
      force: true,
    });
  });

  it('rejects unknown options', () => {
    expect(() => parseIngestArgs(['--everything'])).toThrow();
    expect(() => parseIngestArgs(['positional'])).toThrow();
  });
});

describe('readIngestEnv', () => {
  const url = 'postgres://user:hunter2@db:5432/wanderly';

  it('reads the database URL as a secret and defaults the model settings', () => {
    const env = readIngestEnv({ DATABASE_URL: url, INIT_CWD: '/repo' });

    expect(env.databaseUrl.reveal()).toBe(url);
    expect(String(env.databaseUrl)).toBe('[redacted]');
    expect(env.embeddingModel).toBe('Xenova/bge-small-en-v1.5');
    expect(env.embeddingCacheDir).toBe(path.resolve('/repo', '.cache/models'));
  });

  it('treats blank variables as unset and keeps absolute cache dirs', () => {
    const env = readIngestEnv({
      DATABASE_URL: url,
      EMBEDDING_MODEL: ' ',
      EMBEDDING_CACHE_DIR: path.resolve('/models'),
    });

    expect(env.embeddingModel).toBe('Xenova/bge-small-en-v1.5');
    expect(env.embeddingCacheDir).toBe(path.resolve('/models'));
  });

  it('names the invalid variables without echoing their values', () => {
    expect(() => readIngestEnv({})).toThrow('DATABASE_URL: is required');
    const error = (() => {
      try {
        readIngestEnv({ DATABASE_URL: 'mysql://secret-host' });
      } catch (caught) {
        return caught as Error;
      }
      return null;
    })();
    expect(error?.message).toContain('DATABASE_URL: must be a postgres:// URL');
    expect(error?.message).not.toContain('secret-host');
  });
});

describe('formatReport', () => {
  it('summarizes the run', () => {
    const text = formatReport({
      destinations: { synced: 20, removed: [] },
      documents: { total: 89, indexed: 3, skipped: 86, removed: ['crete/places/old.md'] },
      chunks: { written: 41 },
      embeddingModel: 'Xenova/bge-small-en-v1.5',
      chunking: 'md-v1;target=300',
      durationMs: 12_345,
    });

    expect(text).toBe(
      [
        'Embedding model  Xenova/bge-small-en-v1.5',
        'Chunking         md-v1;target=300',
        'Destinations     20 synced, 0 removed',
        'Documents        89 in corpus: 3 indexed, 86 skipped (unchanged), 1 removed (crete/places/old.md)',
        'Chunks           41 written',
        'Duration         12.3 s',
      ].join('\n'),
    );
  });
});
