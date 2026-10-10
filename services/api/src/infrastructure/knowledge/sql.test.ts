import { describe, expect, it, vi } from 'vitest';
import { insertRows, withTransaction, type PgPool } from './sql.js';

function fakeClient(failOn?: string) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (failOn !== undefined && text.startsWith(failOn)) throw new Error(`failed: ${text}`);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client, query: client.query } as unknown as PgPool;
  return { client, pool, queries };
}

describe('withTransaction', () => {
  it('commits after the work and releases the client', async () => {
    const { client, pool, queries } = fakeClient();

    const result = await withTransaction(pool, async () => 42, 'BEGIN READ ONLY');

    expect(result).toBe(42);
    expect(queries.map((query) => query.text)).toEqual(['BEGIN READ ONLY', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows when the work fails, even if the rollback fails', async () => {
    const { client, pool, queries } = fakeClient('ROLLBACK');

    await expect(
      withTransaction(pool, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(queries.map((query) => query.text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('insertRows', () => {
  it('builds one parameterized multi-row INSERT with optional casts', async () => {
    const { client, queries } = fakeClient();

    await insertRows(
      client,
      'chunks',
      ['id', 'embedding'],
      [
        ['a', '[1,2]'],
        ['b', '[3,4]'],
      ],
      { embedding: '::vector' },
    );

    expect(queries).toEqual([
      {
        text: 'INSERT INTO chunks (id, embedding) VALUES ($1, $2::vector), ($3, $4::vector)',
        values: ['a', '[1,2]', 'b', '[3,4]'],
      },
    ]);
  });

  it('splits large inserts under the bind-parameter limit and skips empty ones', async () => {
    const { client, queries } = fakeClient();
    const columns = Array.from({ length: 6 }, (_, index) => `c${index}`);
    const rows = Array.from({ length: 25_000 }, () => columns.map(() => 1));

    await insertRows(client, 't', columns, rows);
    await insertRows(client, 't', columns, []);

    expect(queries.map((query) => query.values?.length)).toEqual([60_000, 60_000, 30_000]);
  });

  it('rejects a row with the wrong number of values', async () => {
    const { client } = fakeClient();

    await expect(insertRows(client, 't', ['a', 'b'], [['only one']])).rejects.toThrow(
      'expected 2 values per row',
    );
  });
});
