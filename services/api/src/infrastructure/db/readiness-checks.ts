import type { QueryResult, QueryResultRow } from 'pg';
import type { CheckOutcome, ReadinessCheck } from '../../application/ports/readiness.js';

/** The subset of `pg.Pool` the checks need (a fake in unit tests). */
export interface Queryable {
  query<Row extends QueryResultRow>(text: string): Promise<QueryResult<Row>>;
}

/** Postgres SQLSTATE for "relation does not exist". */
const UNDEFINED_TABLE = '42P01';

/** node-pg-migrate's bookkeeping table (default name and schema). */
export const MIGRATIONS_TABLE = 'public.pgmigrations';

/** The database accepts connections and answers a trivial query. */
export function createDatabaseCheck(db: Queryable): ReadinessCheck {
  return {
    name: 'database',
    async run(): Promise<CheckOutcome> {
      await db.query('SELECT 1');
      return { status: 'pass' };
    },
  };
}

/**
 * Every migration shipped with this build has been applied. Extra rows in the
 * table (a newer schema during a rollback) are tolerated: migrations are meant
 * to be backward compatible (expand/contract).
 */
export function createMigrationsCheck(
  db: Queryable,
  expectedMigrations: readonly string[],
): ReadinessCheck {
  if (expectedMigrations.length === 0) {
    throw new Error('No migration files found: the build is missing services/api/migrations');
  }
  const expected = [...expectedMigrations];

  return {
    name: 'migrations',
    async run(): Promise<CheckOutcome> {
      let applied: Set<string>;
      try {
        const result = await db.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
        applied = new Set(result.rows.map((row) => row.name));
      } catch (error) {
        if (sqlState(error) === UNDEFINED_TABLE) {
          return { status: 'fail', output: 'no migration has been applied', detail: error };
        }
        throw error;
      }

      const pending = expected.filter((name) => !applied.has(name));
      return pending.length === 0
        ? { status: 'pass' }
        : {
            status: 'fail',
            output: `${pending.length} pending migration(s)`,
            detail: { pending },
          };
    },
  };
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
