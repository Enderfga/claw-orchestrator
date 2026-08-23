import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 10_000,
    // A hung test must fail with a name, not stall the job. Without these, a
    // hang in a hook or in teardown is not covered by `testTimeout` at all, and
    // CI sat for fourteen minutes with no indication of which file was stuck.
    hookTimeout: 30_000,
    teardownTimeout: 15_000,
  },
});
