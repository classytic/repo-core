import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Pool options are top-level in vitest 4. Integration/e2e projects use
    // singleFork so shared resources (a module-level mongoose connection,
    // global mock registries) can't interleave across workers.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
          pool: 'forks',
          fileParallelism: false,
        },
      },
    ],
  },
});
