import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** `services/api/migrations`, from both `src/infrastructure/db` and `dist/infrastructure/db`. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
);

const SQL_EXTENSION = '.sql';

/**
 * Names of the SQL migrations shipped with this build, as node-pg-migrate records
 * them in `pgmigrations.name` (file name without extension), in run order.
 * Only single-file SQL migrations with Up/Down markers are used in this project.
 */
export async function listMigrationNames(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(SQL_EXTENSION))
    .map((name) => name.slice(0, -SQL_EXTENSION.length))
    .sort(compareMigrationNames);
}

/** Same ordering as node-pg-migrate: numeric prefix first, then name. */
export function compareMigrationNames(a: string, b: string): number {
  const prefixA = numericPrefix(a);
  const prefixB = numericPrefix(b);
  if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
  return a.localeCompare(b, 'en', { numeric: true });
}

function numericPrefix(name: string): number {
  const match = /^\d+/.exec(name);
  return match === null ? Number.POSITIVE_INFINITY : Number(match[0]);
}
