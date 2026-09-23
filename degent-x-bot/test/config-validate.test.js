import { describe, it, expect } from 'vitest';
const {
  validateConfig,
  collectConfigProblems,
  DEFAULT_DATABASE_URL,
} = require('../src/config/validate');

const silentLogger = { warn() {}, info() {}, error() {}, fatal() {} };

function goodConfig(overrides = {}) {
  return {
    nodeEnv: 'production',
    admin: {
      jwtSecret: 'a'.repeat(48),
      username: 'admin',
      password: 'correct-horse-battery-staple',
    },
    databaseUrl: 'postgresql://dgentx:s3cret@postgres:5432/dgentx',
    redisUrl: 'redis://:s3cret@redis:6379',
    twitter: { apiKey: 'k', apiSecret: 's', accessToken: 't', accessTokenSecret: 'ts' },
    ai: { anthropicApiKey: 'x' },
    ...overrides,
  };
}

describe('collectConfigProblems', () => {
  it('accepts a fully configured production config', () => {
    const r = collectConfigProblems(goodConfig());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('flags the shipped placeholder JWT secret and admin password', () => {
    const r = collectConfigProblems(goodConfig({
      admin: { jwtSecret: 'change-me-to-a-random-secret', username: 'admin', password: 'change-me' },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/JWT_SECRET/);
    expect(r.errors.join('\n')).toMatch(/ADMIN_PASSWORD/);
  });

  it('flags missing secrets', () => {
    const r = collectConfigProblems(goodConfig({ admin: { username: 'admin' } }));
    expect(r.errors.some((e) => e.includes('JWT_SECRET'))).toBe(true);
    expect(r.errors.some((e) => e.includes('ADMIN_PASSWORD'))).toBe(true);
  });

  it('flags short secrets', () => {
    const r = collectConfigProblems(goodConfig({
      admin: { jwtSecret: 'short-but-not-a-default', username: 'admin', password: 'tiny' },
    }));
    expect(r.errors.some((e) => /JWT_SECRET must be at least/.test(e))).toBe(true);
    expect(r.errors.some((e) => /ADMIN_PASSWORD must be at least/.test(e))).toBe(true);
  });

  it('flags the default database URL', () => {
    const r = collectConfigProblems(goodConfig({ databaseUrl: DEFAULT_DATABASE_URL }));
    expect(r.errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
  });

  it('warns (does not error) about a passwordless remote redis', () => {
    const r = collectConfigProblems(goodConfig({ redisUrl: 'redis://redis:6379' }));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('REDIS_URL'))).toBe(true);
  });
});

describe('validateConfig', () => {
  const bad = () => goodConfig({
    admin: { jwtSecret: 'change-me-to-a-random-secret', username: 'admin', password: 'change-me' },
  });

  it('throws in production', () => {
    expect(() => validateConfig(bad(), { nodeEnv: 'production', env: {}, logger: silentLogger }))
      .toThrow(/Refusing to start in NODE_ENV=production/);
  });

  it('carries the individual problems on the error', () => {
    let caught;
    try {
      validateConfig(bad(), { nodeEnv: 'production', env: {}, logger: silentLogger });
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('E_INSECURE_CONFIG');
    expect(caught.problems.length).toBeGreaterThanOrEqual(2);
  });

  it('throws in test without an explicit override', () => {
    expect(() => validateConfig(bad(), { nodeEnv: 'test', env: {}, logger: silentLogger }))
      .toThrow(/Refusing to start in NODE_ENV=test/);
  });

  it('allows insecure defaults in test with ALLOW_INSECURE_DEFAULTS=true', () => {
    const r = validateConfig(bad(), { nodeEnv: 'test', env: { ALLOW_INSECURE_DEFAULTS: 'true' }, logger: silentLogger });
    expect(r.ok).toBe(false);
  });

  it('does not honour the override in production', () => {
    expect(() => validateConfig(bad(), { nodeEnv: 'production', env: { ALLOW_INSECURE_DEFAULTS: 'true' }, logger: silentLogger }))
      .toThrow();
  });

  it('only warns in development', () => {
    const warned = [];
    const logger = { ...silentLogger, warn: (...args) => warned.push(args) };
    const r = validateConfig(bad(), { nodeEnv: 'development', env: {}, logger });
    expect(r.ok).toBe(false);
    expect(warned.length).toBeGreaterThan(0);
  });

  it('passes a good config in production', () => {
    const r = validateConfig(goodConfig(), { nodeEnv: 'production', env: {}, logger: silentLogger });
    expect(r.ok).toBe(true);
  });
});
