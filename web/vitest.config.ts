import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * A second Vitest project, separate from the Node suite in the repository root.
 *
 * The backend test files run in Node and several load better-sqlite3, so a DOM
 * environment must not be forced on them globally (issue #51). This project is
 * scoped to the test files under web/src (DOM behavioural `.dom.test.tsx` plus
 * source-reading checks like the static landing page), runs in happy-dom, and
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
    include: ['src/**/*.dom.test.tsx', 'src/**/*.test.ts'],
    environment: 'happy-dom',
    restoreMocks: true,
    clearMocks: true
  }
});
