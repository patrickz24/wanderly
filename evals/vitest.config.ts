import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{scorers,runner,report}/**/*.test.ts'],
    environment: 'node',
  },
});
