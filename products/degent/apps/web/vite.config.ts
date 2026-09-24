/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // The pay sequence and the demo e2e sign real reveals in jsdom; under the parallel
    // workspace run (`pnpm -r test`) they exceed vitest's 5 s default. They pass in isolation.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
