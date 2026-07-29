import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    /**
     * The first test in each file pays the whole cold-start cost of its worker
     * fork: module transform, better-sqlite3 native load, migration of a fresh
     * SQLite file, and Fastify app construction. On a Linux CI runner that is a
     * few hundred milliseconds, but on an operator Windows workstation the same
     * first test has been measured at 7-11 seconds, so a 15 second budget made
     * the release gate depend on machine speed rather than on behaviour.
     *
     * 30 seconds keeps every assertion intact while still failing fast on a real
     * hang: no test in this suite legitimately runs longer than ~11 seconds.
     */
    testTimeout: 30000,
    hookTimeout: 30000,
    restoreMocks: true,
    clearMocks: true
  }
});
