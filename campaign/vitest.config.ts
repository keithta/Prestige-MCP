import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/concurrency/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one Postgres database; running files in parallel
    // would let one file's TRUNCATE wipe another file's fixtures mid-assertion.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['tests/setup.ts'],
  },
});
