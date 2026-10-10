import { ReadyResponseSchema } from '@wanderly/contracts';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { createReadinessProbe } from '../../src/application/readiness.js';
import { Secret } from '../../src/config.js';
import { listMigrationNames } from '../../src/infrastructure/db/migration-files.js';
import { createPool } from '../../src/infrastructure/db/pool.js';
import {
  createDatabaseCheck,
  createMigrationsCheck,
} from '../../src/infrastructure/db/readiness-checks.js';
import { testConfig } from '../support.js';
import { createScratchDatabase, requireDatabaseUrl, type ScratchDatabase } from './db.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Wires the real adapters exactly like main.ts, against the given database. */
async function startAgainst(databaseUrl: string): Promise<App> {
  const pool: pg.Pool = createPool({
    url: new Secret(databaseUrl),
    onIdleClientError: () => undefined,
  });
  cleanups.push(() => pool.end());

  const app = await buildApp({
    config: testConfig({ DATABASE_URL: databaseUrl }),
    readinessProbe: createReadinessProbe([
      createDatabaseCheck(pool),
      createMigrationsCheck(pool, await listMigrationNames()),
    ]),
  });
  cleanups.push(() => app.close());
  return app;
}

describe('GET /ready against a real database', () => {
  it('returns 200 when the database is reachable and fully migrated', async () => {
    const app = await startAgainst(requireDatabaseUrl());

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    const body = ReadyResponseSchema.parse(response.json());
    expect(body.status).toBe('pass');
    expect(body.checks['database']?.status).toBe('pass');
    expect(body.checks['migrations']?.status).toBe('pass');
  });

  it('returns 503 when migrations have not been applied', async () => {
    const scratch: ScratchDatabase = await createScratchDatabase();
    cleanups.push(() => scratch.drop());
    const app = await startAgainst(scratch.url);

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'fail',
      checks: {
        database: { status: 'pass' },
        migrations: { status: 'fail', output: 'no migration has been applied' },
      },
    });
  });

  it('returns 503 without leaking connection details when the database is unreachable', async () => {
    const unreachable = 'postgres://wanderly:not-the-password@127.0.0.1:1/wanderly';
    const app = await startAgainst(unreachable);

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'fail',
      checks: {
        database: { status: 'fail', output: 'check failed' },
        migrations: { status: 'fail', output: 'check failed' },
      },
    });
    expect(response.body).not.toContain('not-the-password');
    expect(response.body).not.toContain('127.0.0.1');
  });
});
