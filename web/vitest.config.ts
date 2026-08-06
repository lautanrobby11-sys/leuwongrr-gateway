import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * A second Vitest project, separate from the Node suite in the repository root.
 *
 * The backend test files run in Node and several load better-sqlite3, so a DOM
 * environment must not be forced on them globally (issue #51). This project is
 * scoped to the `.dom.test.tsx` files under web/src, runs in happy-dom, and
 * shares web/'s single React install so the rendered component and
 * `@testing-library/react` resolve the same react with no dual-package hazard.
 *
 * The root `vitest.config.ts` lists this project alongside the Node suite via
 * `test.projects`, so `npm run validate` (root `vitest run`) executes both suites
 * without touching the Node project's `pool: 'forks'` / `fileParallelism: false`
 * settings. happy-dom is a root devDependency because Vitest resolves the
 * environment package from its own install location, not from this project root.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'console-dom',
    include: ['src/**/*.dom.test.tsx'],
    environment: 'happy-dom',
    restoreMocks: true,
    clearMocks: true
  }
});
