/**
 * Deletes the conversations past the retention period: `npm run purge -w @wanderly/api`
 * (or `node dist/cli/purge.js` in the API image, e.g. from a cron job). The API also runs the
 * same purge at startup and every 24 hours.
 *
 *   --dry-run   count what would be deleted, delete nothing
 *
 * Reads DATABASE_URL and RETENTION_DAYS only: a cron job must not need the API's secrets.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  createPurgeExpiredConversations,
  type PurgeResult,
} from '../application/purge-expired-conversations.js';
import { RetentionDaysSchema, Secret } from '../config.js';
import { SYSTEM_CLOCK } from '../domain/ports/tracer.js';
import { createPool } from '../infrastructure/db/pool.js';
import { poolDatabase } from '../infrastructure/persistence/database.js';
import { PgRetentionStore } from '../infrastructure/persistence/pg-retention-store.js';

export interface PurgeCliOptions {
  readonly dryRun: boolean;
}

export function parsePurgeArgs(argv: readonly string[]): PurgeCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { 'dry-run': { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });
  return { dryRun: values['dry-run'] };
}

const PurgeEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'is required' })
    .trim()
    .refine((value) => /^postgres(ql)?:\/\/./.test(value), 'must be a postgres:// URL'),
  RETENTION_DAYS: RetentionDaysSchema,
});

export interface PurgeEnv {
  readonly databaseUrl: Secret;
  readonly retentionDays: number;
}

/** Validates the variables the purge needs; messages name variables, never their values. */
export function readPurgeEnv(env: Readonly<Record<string, string | undefined>>): PurgeEnv {
  const blankAsUnset = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = PurgeEnvSchema.safeParse(blankAsUnset);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  - ${issues.join('\n  - ')}`);
  }
  return {
    databaseUrl: new Secret(result.data.DATABASE_URL),
    retentionDays: result.data.RETENTION_DAYS,
  };
}

export function formatPurgeResult(result: PurgeResult): string {
  const verb = result.dryRun ? 'Would delete' : 'Deleted';
  return [
    `${verb} ${result.conversations} conversation(s) inactive since before ` +
      `${result.cutoff.toISOString()} (retention ${result.retentionDays} day(s)),`,
    `with ${result.messages} message(s), ${result.runs} run(s) and ${result.feedback} feedback.`,
  ].join(' ');
}

async function main(): Promise<void> {
  const options = parsePurgeArgs(process.argv.slice(2));
  const env = readPurgeEnv(process.env);
  const pool = createPool({
    url: env.databaseUrl,
    onIdleClientError: (error) => console.error('idle Postgres client error:', error.message),
    max: 2,
  });
  try {
    const purge = createPurgeExpiredConversations({
      store: new PgRetentionStore(poolDatabase(pool)),
      clock: SYSTEM_CLOCK,
      retentionDays: env.retentionDays,
    });
    console.log(formatPurgeResult(await purge.execute({ dryRun: options.dryRun })));
  } finally {
    await pool.end();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error('Purge failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
