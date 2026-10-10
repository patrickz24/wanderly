import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{scorers,runner,report,judge}/**/*.test.ts'],
    environment: 'node',
  },
});
