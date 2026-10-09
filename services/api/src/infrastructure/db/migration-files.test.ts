import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  compareMigrationNames,
  listMigrationNames,
} from './migration-files.js';

describe('listMigrationNames', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wanderly-migrations-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns SQL migration names without extension, in run order', async () => {
    for (const file of [
      '1791552735347_initial-schema.sql',
      '900_older.sql',
      '1791552735348_next.sql',
      'README.md',
      '.hidden.sql',
    ]) {
      await writeFile(join(dir, file), '-- Up Migration\n');
    }
    await mkdir(join(dir, 'nested.sql'));

    expect(await listMigrationNames(dir)).toEqual([
      '900_older',
      '1791552735347_initial-schema',
      '1791552735348_next',
    ]);
  });

  it('returns an empty list for an empty directory', async () => {
    expect(await listMigrationNames(dir)).toEqual([]);
  });

  it('rejects when the directory does not exist', async () => {
    await expect(listMigrationNames(join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
  });

  it('finds the migrations shipped with the API by default', async () => {
    expect(DEFAULT_MIGRATIONS_DIR.replaceAll('\\', '/')).toMatch(/services\/api\/migrations$/);
    const names = await listMigrationNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => /^\d+_[a-z0-9-]+$/.test(name))).toBe(true);
  });
});

describe('compareMigrationNames', () => {
  it('orders by numeric prefix, then by name', () => {
    const names = ['10_b', '2_a', '10_a', 'z_no_prefix', '2_b'];
    expect(names.sort(compareMigrationNames)).toEqual([
      '2_a',
      '2_b',
      '10_a',
      '10_b',
      'z_no_prefix',
    ]);
  });
});
