import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Full Block and Large Degent tests sign real 1.2M-3.5M WU reveals; under the
    // parallel workspace run (`pnpm -r test`) they exceed vitest's 5 s default.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
