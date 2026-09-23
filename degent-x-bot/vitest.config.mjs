import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    env: {
      NODE_ENV: 'test',
      ALLOW_INSECURE_DEFAULTS: 'true',
      LOG_LEVEL: 'silent',
    },
  },
});
