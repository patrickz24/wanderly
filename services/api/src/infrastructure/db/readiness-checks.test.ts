import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS_TABLE,
  createDatabaseCheck,
  createMigrationsCheck,
  type Queryable,
} from './readiness-checks.js';

const signal = new AbortController().signal;

function fakeDb(respond: (text: string) => Promise<QueryResultRow[]>): Queryable & {
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    async query<Row extends QueryResultRow>(text: string): Promise<QueryResult<Row>> {
      queries.push(text);
      const rows = (await respond(text)) as Row[];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
  };
}

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe('createDatabaseCheck', () => {
  it('passes when the database answers', async () => {
    const db = fakeDb(async () => [{ '?column?': 1 }]);
    const check = createDatabaseCheck(db);

    expect(check.name).toBe('database');
    await expect(check.run(signal)).resolves.toEqual({ status: 'pass' });
    expect(db.queries).toEqual(['SELECT 1']);
  });

  it('propagates connection errors (the probe turns them into a failure)', async () => {
    const check = createDatabaseCheck(
      fakeDb(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    await expect(check.run(signal)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('createMigrationsCheck', () => {
  const expected = ['1_initial', '2_next'];

  it('passes when every shipped migration is applied', async () => {
    const db = fakeDb(async () => [{ name: '1_initial' }, { name: '2_next' }]);
    const check = createMigrationsCheck(db, expected);

    expect(check.name).toBe('migrations');
    await expect(check.run(signal)).resolves.toEqual({ status: 'pass' });
    expect(db.queries).toEqual([`SELECT name FROM ${MIGRATIONS_TABLE}`]);
  });

  it('tolerates migrations applied by a newer build', async () => {
    const db = fakeDb(async () => [{ name: '1_initial' }, { name: '2_next' }, { name: '3_newer' }]);
    await expect(createMigrationsCheck(db, expected).run(signal)).resolves.toEqual({
      status: 'pass',
    });
  });

  it('fails with a count publicly and the pending names as detail', async () => {
    const db = fakeDb(async () => [{ name: '1_initial' }]);
    await expect(createMigrationsCheck(db, expected).run(signal)).resolves.toEqual({
      status: 'fail',
      output: '1 pending migration(s)',
      detail: { pending: ['2_next'] },
    });
  });

  it('fails when no migration has ever run', async () => {
    const missingTable = pgError('42P01');
    const db = fakeDb(async () => {
      throw missingTable;
    });
    await expect(createMigrationsCheck(db, expected).run(signal)).resolves.toEqual({
      status: 'fail',
      output: 'no migration has been applied',
      detail: missingTable,
    });
  });

  it.each([pgError('57P01'), new Error('socket hang up'), 'not an error'])(
    'propagates other errors (%s)',
    async (failure) => {
      const db = fakeDb(async () => {
        throw failure;
      });
      await expect(createMigrationsCheck(db, expected).run(signal)).rejects.toBe(failure);
    },
  );

  it('refuses to start without any migration file', () => {
    expect(() =>
      createMigrationsCheck(
        fakeDb(async () => []),
        [],
      ),
    ).toThrow('No migration files found');
  });

  it('copies the expected list so later mutations do not change the check', async () => {
    const names = ['1_initial'];
    const check = createMigrationsCheck(
      fakeDb(async () => [{ name: '1_initial' }]),
      names,
    );
    names.push('2_added_later');
    await expect(check.run(signal)).resolves.toEqual({ status: 'pass' });
  });
});
