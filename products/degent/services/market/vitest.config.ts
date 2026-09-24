import { defineConfig } from 'vitest/config';

/**
 * Timeouts are hang detectors, not performance assertions. These suites sign and verify real Bitcoin
 * transactions (CPU-bound); `pnpm test` runs packages in parallel and CI boxes are shared, so under
 * oversubscription a sub-second test can exceed vitest's 5 s default. A generous bound keeps results
 * deterministic without hiding a genuine hang.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
