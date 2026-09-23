/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

/** Root-level tests (repository metadata: roadmap, schemas). Package tests run via `pnpm -r test`. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
