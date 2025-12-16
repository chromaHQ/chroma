import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/**/*.test.{ts,tsx}'],
    // Use jsdom for React component tests
    environmentMatchGlobs: [['packages/react/**/*.test.tsx', 'jsdom']],
  },
});
