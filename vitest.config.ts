import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
    restoreMocks: true,
    clearMocks: true
  }
});
