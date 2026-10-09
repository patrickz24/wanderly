import pg from 'pg';
import type { Secret } from '../../config.js';

export interface PoolOptions {
  readonly url: Secret;
  /** Called when an idle client errors (e.g. the server restarts); unhandled, it would crash the process. */
  readonly onIdleClientError: (error: Error) => void;
  readonly max?: number;
}

/**
 * Creates the shared Postgres connection pool. Connection attempts fail fast so
 * that readiness probes and requests do not hang when the database is down.
 */
export function createPool({ url, onIdleClientError, max = 10 }: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url.reveal(),
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'wanderly-api',
  });
  pool.on('error', onIdleClientError);
  return pool;
}
