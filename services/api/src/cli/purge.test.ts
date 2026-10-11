import { describe, expect, it } from 'vitest';
import type { PurgeResult } from '../application/purge-expired-conversations.js';
import { formatPurgeResult, parsePurgeArgs, readPurgeEnv } from './purge.js';

describe('parsePurgeArgs', () => {
  it('deletes by default and only counts with --dry-run', () => {
    expect(parsePurgeArgs([])).toEqual({ dryRun: false });
    expect(parsePurgeArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  it('rejects unknown options and positionals', () => {
    expect(() => parsePurgeArgs(['--all'])).toThrow();
    expect(() => parsePurgeArgs(['30'])).toThrow();
  });
});

describe('readPurgeEnv', () => {
  const url = 'postgres://user:hunter2@db:5432/wanderly';

  it('reads the database URL as a secret and defaults to 30 days', () => {
    const env = readPurgeEnv({ DATABASE_URL: url, RETENTION_DAYS: ' ' });

    expect(env.databaseUrl.reveal()).toBe(url);
    expect(String(env.databaseUrl)).toBe('[redacted]');
    expect(env.retentionDays).toBe(30);
  });

  it('reads RETENTION_DAYS without needing the API secrets', () => {
    expect(readPurgeEnv({ DATABASE_URL: url, RETENTION_DAYS: '7' }).retentionDays).toBe(7);
  });

  it('names the invalid variables, never their values', () => {
    const attempt = () =>
      readPurgeEnv({ DATABASE_URL: 'mysql://root:hunter2@db/app', RETENTION_DAYS: '0' });

    expect(attempt).toThrow(/DATABASE_URL: must be a postgres:\/\/ URL/);
    expect(attempt).toThrow(/RETENTION_DAYS: /);
    expect(attempt).not.toThrow(/hunter2/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => readPurgeEnv({})).toThrow(/DATABASE_URL: is required/);
  });
});

describe('formatPurgeResult', () => {
  const result: PurgeResult = {
    retentionDays: 30,
    cutoff: new Date('2026-09-11T10:00:00.000Z'),
    dryRun: false,
    conversations: 3,
    messages: 40,
    runs: 6,
    feedback: 1,
    batches: 1,
  };

  it('says what was deleted', () => {
    expect(formatPurgeResult(result)).toBe(
      'Deleted 3 conversation(s) inactive since before 2026-09-11T10:00:00.000Z (retention 30 day(s)), with 40 message(s), 6 run(s) and 1 feedback.',
    );
  });

  it('says what would be deleted in a dry run', () => {
    expect(formatPurgeResult({ ...result, dryRun: true })).toMatch(/^Would delete 3 conversation/);
  });
});
