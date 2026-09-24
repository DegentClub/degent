import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Full Block compositing renders up to 4096 px canvases; give it room on slow CI hosts.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
