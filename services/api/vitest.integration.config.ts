import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres + pgvector database.
 * They need DATABASE_URL and a migrated schema (`npm run migrate -w @wanderly/api`).
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    // Tests share one database: run files sequentially to keep them deterministic.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
