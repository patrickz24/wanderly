import { defineConfig } from 'vitest/config';

const CORE_THRESHOLDS = { lines: 80, branches: 80, functions: 80, statements: 80 };

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      reporter: ['text', 'html', 'json-summary'],
      // The pure core (domain + use cases) is gated; adapters are covered by integration tests.
      thresholds: {
        'src/domain/**': CORE_THRESHOLDS,
        'src/application/**': CORE_THRESHOLDS,
      },
    },
  },
});
