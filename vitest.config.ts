import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two projects run under one `vitest run` (issue #51): the Node backend
    // suite below, and the happy-dom console suite in ./web/vitest.config.ts.
    // Splitting them keeps the DOM environment off the 40 backend files (several
    // load better-sqlite3). `fileParallelism` is a global runner option, so it
    // stays here at the root and still forces the backend files to run serially.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          pool: 'forks',
          /**
           * The first test in each file pays the whole cold-start cost of its worker
           * fork: module transform, better-sqlite3 native load, migration of a fresh
           * SQLite file, and Fastify app construction. On a Linux CI runner that is a
           * few hundred milliseconds, but on an operator Windows workstation the same
           * first test has been measured at 7-11 seconds, so a 15 second budget made
           * the release gate depend on machine speed rather than on behaviour.
           *
           * The first test of tests/stream-e2e.test.ts is worse still, because it is
           * the only one that also binds a real TCP listener on that cold path: it was
           * measured at ~33.9 seconds on the operator workstation while the same
           * commit was green on Linux CI.
           *
           * 45 seconds clears that measured worst case while staying below the 60
           * second upstream hang timer used by the streaming fixtures, so a genuine
           * hang still fails the gate instead of outliving the deadline. Hangs are
           * also caught much earlier by the in-test waitFor budget and by
           * STREAM_IDLE_TIMEOUT_MS / REQUEST_TIMEOUT_MS inside each harness.
           *
           * Keep this the single source of truth: per-test inline `timeout` options
           * silently override this value, so scripts/check-conventions.mjs rejects
           * them in tests/.
           */
          testTimeout: 45000,
          hookTimeout: 45000,
          restoreMocks: true,
          clearMocks: true
        }
      },
      './web/vitest.config.ts'
    ]
  }
});
