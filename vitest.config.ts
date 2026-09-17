import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup-isolate-home.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 10_000,
    // A hung test must fail with a name, not stall the job. Without these, a
    // hang in a hook or in teardown is not covered by `testTimeout` at all, and
    // CI sat for fourteen minutes with no indication of which file was stuck.
    hookTimeout: 30_000,
    teardownTimeout: 15_000,
    // A runaway in code under test must not take the machine down with it. On
    // 2026-09-17 an unbounded loop grew each worker's heap to its ~4GB default
    // before V8 aborted, several workers did it at once, and the host ran out of
    // memory. A 1GB heap per worker and at most four workers keeps the worst case
    // near 5GB, and the runaway still fails loudly as a heap-limit crash.
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=1024'] },
    },
  },
});
