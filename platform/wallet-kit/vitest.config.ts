import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Adapters read injected providers off `window`, so every test runs in a DOM.
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
  },
});
