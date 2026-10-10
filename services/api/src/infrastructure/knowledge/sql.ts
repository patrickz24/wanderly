import type pg from 'pg';

/** The part of `pg.Pool` the knowledge adapters use. */
export type PgPool = Pick<pg.Pool, 'connect' | 'query'>;

/** Runs `work` in a transaction on one pooled client: COMMIT on success, ROLLBACK on error. */
export async function withTransaction<T>(
  pool: PgPool,
  work: (client: pg.PoolClient) => Promise<T>,
  begin = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Anything that runs a parameterized statement (a pool client in practice). */
export interface SqlExecutor {
  query(text: string, values: unknown[]): Promise<unknown>;
}

/** Postgres accepts at most 65,535 bind parameters per statement. */
const MAX_PARAMETERS = 60_000;

/**
 * Multi-row parameterized INSERT, split into statements below the bind-parameter limit.
 * `table` and `columns` are code constants, never user input; every value is a bind parameter.
 * `casts` optionally appends a cast to a column's placeholder (e.g. `::vector`).
 */
export async function insertRows(
  client: SqlExecutor,
  table: string,
  columns: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
  casts: Readonly<Record<string, string>> = {},
): Promise<void> {
  const rowsPerStatement = Math.max(1, Math.floor(MAX_PARAMETERS / columns.length));
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const batch = rows.slice(start, start + rowsPerStatement);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      if (row.length !== columns.length) {
        throw new Error(`insert into ${table}: expected ${columns.length} values per row`);
      }
      const placeholders = row.map((value, index) => {
        values.push(value);
        const column = columns[index] as string;
        return `$${values.length}${casts[column] ?? ''}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}
