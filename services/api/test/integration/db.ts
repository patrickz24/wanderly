import { randomBytes } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { DEFAULT_MIGRATIONS_DIR } from '../../src/infrastructure/db/migration-files.js';

export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'Integration tests need DATABASE_URL (a disposable Postgres 16 + pgvector database).',
    );
  }
  return url;
}

export interface ScratchDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

/**
 * Creates an empty, uniquely named database next to DATABASE_URL so that tests
 * can migrate up and down without touching the shared database.
 * Requires a role allowed to create databases and the vector extension (the
 * default superuser of the pgvector image).
 */
export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const baseUrl = requireDatabaseUrl();
  const name = `wanderly_it_${randomBytes(6).toString('hex')}`;

  await withClient(baseUrl, (client) => client.query(`CREATE DATABASE ${name}`));

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;

  return {
    name,
    url: url.toString(),
    drop: () =>
      withClient(baseUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }),
  };
}

export async function withClient<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Runs the project's SQL migrations exactly like `npm run migrate`, but in-process. */
export async function migrate(url: string, direction: 'up' | 'down'): Promise<string[]> {
  const applied = await runner({
    databaseUrl: url,
    dir: DEFAULT_MIGRATIONS_DIR,
    direction,
    count: Number.POSITIVE_INFINITY,
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  return applied.map((migration) => migration.name);
}
