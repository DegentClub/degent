/** Environment -> config: defaults on regtest, every problem listed at once, unsafe combinations refused. */
import { describe, expect, it } from 'vitest';
import { generateApiKey } from '@bsh/edge';
import { ConfigError, loadConfig } from '../src/config.js';

const problems = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
};

describe('loadConfig', () => {
  it('regtest works with nothing but NETWORK and picks safe dev defaults', () => {
    const c = loadConfig({ NETWORK: 'regtest' });
    expect(c.settings.network).toBe('regtest');
    expect(c.port).toBe(8790);
    expect(c.databasePath).toBeNull();
    expect(c.contentDir).toBeNull();
    expect(c.sessionSigningKey).toBeNull();
    expect(c.settings.siwb).toEqual({ domain: 'localhost:8790', uri: 'http://localhost:8790', ttlSeconds: 300, statement: null });
    expect(c.settings.session).toEqual({ ttlSeconds: 86_400, issuer: 'degent-studio', audience: 'degent', scopes: ['artist'] });
    expect(c.settings.rules.requireSquare).toBe(true);
    expect(c.settings.rules.network).toBe('regtest');
    expect(c.settings.visionReview).toBe('none');
    expect(c.apiKeyEnvironment).toBe('test');
    expect(c.apiKeys).toEqual([]);
    expect(c.settings.maxUploadBytes).toBe(4 * 1024 * 1024);
  });

  it('NETWORK is required and validated', () => {
    expect(problems({})).toContain('NETWORK is required: one of mainnet, testnet, signet, regtest');
    expect(problems({ NETWORK: 'liquid' })[0]).toContain('NETWORK');
  });

  it('mainnet requires persistence, SIWB domain, a session key, and lists every problem at once', () => {
    const p = problems({ NETWORK: 'mainnet' });
    expect(p).toEqual(
      expect.arrayContaining([
        'DATABASE_PATH is required on mainnet',
        'CONTENT_DIR is required on mainnet',
        'SIWB_DOMAIN is required on mainnet',
        'SESSION_SIGNING_KEY is required on mainnet',
      ]),
    );
  });

  it('a full mainnet configuration loads', () => {
    const k = generateApiKey('live');
    const c = loadConfig({
      NETWORK: 'mainnet',
      DATABASE_PATH: '/var/lib/studio/studio.db',
      CONTENT_DIR: '/var/lib/studio/content',
      SIWB_DOMAIN: 'studio.degent.club',
      SESSION_SIGNING_KEY: 'ab'.repeat(32),
      SESSION_PREVIOUS_KEYS: 'degent-studio-0:' + 'cd'.repeat(32),
      API_KEYS: JSON.stringify([{ id: 'house', hash: k.hash, scopes: ['studio:review'] }, { id: 'mint', hash: k.hash, scopes: ['studio:internal'], env: 'live', name: 'mint svc' }]),
      VISION_REVIEW_API_KEY: 'sk-ant',
      CORS_ORIGINS: 'https://degent.club, https://www.degent.club',
      TRUSTED_PROXIES: '10.40.0.0/16',
      PUBLIC_BASE_URL: 'https://studio.degent.club/',
    });
    expect(c.settings.siwb).toEqual({ domain: 'studio.degent.club', uri: 'https://studio.degent.club', ttlSeconds: 300, statement: null });
    expect(c.settings.visionReview).toBe('claude');
    expect(c.apiKeyEnvironment).toBe('live');
    expect(c.apiKeys.map((x) => [x.id, x.env, x.scopes])).toEqual([['house', 'live', ['studio:review']], ['mint', 'live', ['studio:internal']]]);
    expect(c.apiKeys[1]!.name).toBe('mint svc');
    expect(c.sessionPreviousKeys).toEqual([{ kid: 'degent-studio-0', publicKeyHex: 'cd'.repeat(32) }]);
    expect(c.corsOrigins).toEqual(['https://degent.club', 'https://www.degent.club']);
    expect(c.trustedProxies).toEqual(['10.40.0.0/16']);
    expect(c.settings.publicBaseUrl).toBe('https://studio.degent.club');
  });

  it('refuses test API keys and a test key environment on mainnet', () => {
    const base = { NETWORK: 'mainnet', DATABASE_PATH: 'x', CONTENT_DIR: 'y', SIWB_DOMAIN: 'studio.degent.club', SESSION_SIGNING_KEY: 'ab'.repeat(32) };
    expect(problems({ ...base, API_KEYS: JSON.stringify([{ id: 'k', hash: 'a'.repeat(64), scopes: ['studio:review'], env: 'test' }]) })).toContain('mainnet accepts only live API keys');
    expect(problems({ ...base, API_KEY_ENVIRONMENT: 'test' })).toContain('API_KEY_ENVIRONMENT must be live on mainnet');
  });

  it('validates API_KEYS records', () => {
    const base = { NETWORK: 'regtest' };
    expect(problems({ ...base, API_KEYS: 'nope' })).toContain('API_KEYS must be a JSON array');
    expect(problems({ ...base, API_KEYS: '{}' })).toContain('API_KEYS must be a JSON array');
    expect(problems({ ...base, API_KEYS: JSON.stringify([{ id: 'k' }]) })[0]).toContain('API_KEYS[0] needs id and hash');
    expect(problems({ ...base, API_KEYS: JSON.stringify([{ id: 'k', hash: 'a'.repeat(64), scopes: ['admin'] }]) })[0]).toContain('scopes');
    expect(problems({ ...base, API_KEYS: JSON.stringify([{ id: 'k', hash: 'a'.repeat(64), scopes: ['studio:review'], env: 'prod' }]) })[0]).toContain('env');
    expect(loadConfig({ ...base, API_KEYS: JSON.stringify([{ id: 'k', hash: 'a'.repeat(64), scopes: ['studio:review', 'studio:internal'] }]) }).apiKeys[0]!.env).toBe('test');
  });

  it('validates SIWB settings', () => {
    expect(problems({ NETWORK: 'regtest', SIWB_DOMAIN: 'https://x.y' })).toContain('SIWB_DOMAIN must be a lower-case host[:port]');
    expect(problems({ NETWORK: 'regtest', SIWB_DOMAIN: 'studio.degent.club', SIWB_URI: 'https://evil.example' })).toContain('SIWB_URI host must equal SIWB_DOMAIN');
    expect(problems({ NETWORK: 'regtest', SIWB_DOMAIN: 'studio.degent.club', SIWB_URI: 'http://studio.degent.club' })).toContain('SIWB_URI must be https (http only for localhost)');
    expect(problems({ NETWORK: 'regtest', SIWB_URI: 'nope' })).toContain('SIWB_URI must be a URL');
    expect(problems({ NETWORK: 'regtest', SIWB_TTL_SECONDS: '3601' })[0]).toContain('SIWB_TTL_SECONDS');
    expect(problems({ NETWORK: 'regtest', SIWB_STATEMENT: 'two\nlines' })[0]).toContain('SIWB_STATEMENT');
    expect(loadConfig({ NETWORK: 'regtest', SIWB_DOMAIN: 'studio.degent.club' }).settings.siwb.uri).toBe('https://studio.degent.club');
    expect(loadConfig({ NETWORK: 'regtest', SIWB_STATEMENT: 'Sign in to the studio.' }).settings.siwb.statement).toBe('Sign in to the studio.');
  });

  it('validates session settings', () => {
    expect(problems({ NETWORK: 'regtest', SESSION_SIGNING_KEY: 'xyz' })).toContain('SESSION_SIGNING_KEY must be 32 bytes of hex (64 characters)');
    expect(problems({ NETWORK: 'regtest', SESSION_KID: 'bad kid!' })[0]).toContain('SESSION_KID');
    expect(problems({ NETWORK: 'regtest', SESSION_PREVIOUS_KEYS: 'k1:short' })[0]).toContain('SESSION_PREVIOUS_KEYS');
    expect(problems({ NETWORK: 'regtest', SESSION_TTL_SECONDS: '59' })[0]).toContain('SESSION_TTL_SECONDS');
    expect(loadConfig({ NETWORK: 'regtest', SESSION_TTL_SECONDS: '600', SESSION_ISSUER: 'x' }).settings.session).toMatchObject({ ttlSeconds: 600, issuer: 'x' });
  });

  it('validates origins, proxies, base url and numbers', () => {
    expect(problems({ NETWORK: 'regtest', CORS_ORIGINS: 'degent.club' })[0]).toContain('CORS_ORIGINS');
    expect(problems({ NETWORK: 'regtest', CORS_ORIGINS: 'https://degent.club/' })[0]).toContain('CORS_ORIGINS');
    expect(problems({ NETWORK: 'regtest', TRUSTED_PROXIES: 'not an ip' })[0]).toContain('TRUSTED_PROXIES');
    expect(problems({ NETWORK: 'regtest', PUBLIC_BASE_URL: 'ftp://x' })[0]).toContain('PUBLIC_BASE_URL');
    expect(problems({ NETWORK: 'regtest', PORT: '70000' })[0]).toContain('PORT');
    expect(problems({ NETWORK: 'regtest', RATE_LIMIT_PER_MINUTE: '0' })[0]).toContain('RATE_LIMIT_PER_MINUTE');
    expect(loadConfig({ NETWORK: 'regtest', PORT: '9000' }).settings.siwb.domain).toBe('localhost:9000');
  });

  it('every variable in env.schema.json is read by loadConfig and vice versa', async () => {
    const { readFileSync } = await import('node:fs');
    const schema = JSON.parse(readFileSync(new URL('../env.schema.json', import.meta.url), 'utf8'));
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const declared = Object.keys(schema.properties).sort();
    const read = [...new Set([...src.matchAll(/\b(?:str|int|need|list)\('([A-Z_]+)'/g)].map((m) => m[1]!))].sort();
    expect(read).toEqual(declared);
    expect(schema.required).toEqual(['NETWORK']);
  });
});
