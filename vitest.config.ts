import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // .claude/ holds session worktrees with their own copies of the tests.
    exclude: ['node_modules/**', 'dist/**', '.claude/**'],
  },
});
