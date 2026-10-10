import type pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

/** Executes parameterized SQL. Values are always sent separately from the statement text. */
export interface SqlExecutor {
  query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

/**
 * A database handle that can run work in a transaction. Inside `transaction`, the handle given to
 * `work` is bound to one connection; nested `transaction` calls join the outer transaction, so a
 * repository method that needs atomicity works both alone and inside a unit of work.
 */
export interface Database extends SqlExecutor {
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
}

export function poolDatabase(pool: pg.Pool): Database {
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(work) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await work(transactionDatabase(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection is in an unknown state: destroy it instead of returning it to the pool.
          broken = rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK failed');
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
  };
}

function transactionDatabase(client: pg.PoolClient): Database {
  const tx: Database = {
    query: (text, values) => client.query(text, values),
    transaction: (work) => work(tx),
  };
  return tx;
}
