import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  API_KEY_RE,
  InMemoryApiKeyStore,
  apiKeys,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  timingSafeEqual,
  type ApiKeyStore,
  type ApiKeysOptions,
} from '../src/index.js';
import { json } from './helpers.js';

function setup(opts: Partial<ApiKeysOptions> = {}, quota?: { limit: number; windowMs: number }) {
  const store = new InMemoryApiKeyStore();
  const live = generateApiKey('live');
  const test = generateApiKey('test');
  store.add({ id: 'key_live', hash: live.hash, env: 'live', scopes: ['orders:read', 'orders:write'], ownerId: 'acct_1', ...(quota ? { quota } : {}) });
  store.add({ id: 'key_test', hash: test.hash, env: 'test', scopes: ['orders:read'] });
  const app = new Hono();
  app.use(apiKeys({ store, ...opts }));
  app.get('/', (c) => c.json({ principal: c.get('apiKey') ?? null }));
  return { app, store, live, test };
}
const call = (app: Hono, headers: Record<string, string> = {}) => Promise.resolve(app.request('/', { headers }));

describe('API key format', () => {
  it('generates bsh_live_ / bsh_test_ keys with 256-bit secrets and stores only the hash', () => {
    const k = generateApiKey('live');
    expect(k.key).toMatch(API_KEY_RE);
    expect(k.key.startsWith('bsh_live_')).toBe(true);
    expect(k.hash).toBe(hashApiKey(k.key));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.hint).toMatch(/^bsh_live_….{4}$/);
    expect(k.hash).not.toContain(k.key.slice(9));
    expect(generateApiKey('live').key).not.toBe(k.key);
    expect(parseApiKey(generateApiKey('test').key)).toEqual({ env: 'test' });
    for (const bad of ['bsh_prod_' + 'a'.repeat(44), 'bsh_live_short', 'sk_live_' + 'a'.repeat(44), 'bsh_live_' + '0'.repeat(44)])
      expect(parseApiKey(bad)).toBeUndefined();
  });

  it('SHA-256 of the key (known answer)', () => {
    // sha256("abc")
    expect(hashApiKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('timingSafeEqual', () => {
    expect(timingSafeEqual('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqual('abcd', 'abce')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
  });

  it('store refuses anything but a SHA-256 hash (no plaintext keys)', () => {
    const store = new InMemoryApiKeyStore();
    expect(() => store.add({ id: 'x', hash: generateApiKey('live').key, env: 'live', scopes: [] })).toThrow();
  });
});

describe('apiKeys()', () => {
  it('accepts X-API-Key and Authorization: Bearer; exposes the principal without the secret', async () => {
    const { app, live } = setup();
    for (const headers of [{ 'X-API-Key': live.key }, { Authorization: `Bearer ${live.key}` }] as Record<string, string>[]) {
      const res = await call(app, headers);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { principal: unknown };
      expect(body.principal).toEqual({ id: 'key_live', env: 'live', scopes: ['orders:read', 'orders:write'], ownerId: 'acct_1' });
      expect(JSON.stringify(body)).not.toContain(live.key);
    }
  });

  it('401 missing_api_key when required and absent (non-bsh bearer tokens are not keys)', async () => {
    const { app } = setup();
    const res = await call(app);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect((await json(res)).error.code).toBe('missing_api_key');
    expect((await json(await call(app, { Authorization: 'Bearer eyJhbGciOiJFZERTQSJ9.e30.x' }))).error.code).toBe('missing_api_key');
  });

  it('optional mode lets anonymous requests through but still rejects bad keys', async () => {
    const { app } = setup({ required: false });
    const res = await call(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principal: null });
    expect((await call(app, { 'X-API-Key': 'bsh_live_nope' })).status).toBe(401);
  });

  it('401 invalid_api_key for malformed, unknown, revoked and expired keys (indistinguishable)', async () => {
    const { app, store, live } = setup();
    const unknown = generateApiKey('live').key;
    const bodies = [];
    for (const k of ['garbage', unknown, `${live.key}x`]) {
      const r = await call(app, { 'X-API-Key': k });
      expect(r.status).toBe(401);
      bodies.push((await json(r)).error.message);
    }
    store.revoke('key_live');
    const revoked = await call(app, { 'X-API-Key': live.key });
    expect(revoked.status).toBe(401);
    bodies.push((await json(revoked)).error.message);
    expect(new Set(bodies).size).toBe(1);

    const s2 = new InMemoryApiKeyStore();
    const k2 = generateApiKey('live');
    s2.add({ id: 'exp', hash: k2.hash, env: 'live', scopes: [], expiresAt: 1000 });
    const a2 = new Hono().use(apiKeys({ store: s2, now: () => 1000 })).get('/', (c) => c.text('ok'));
    expect((await Promise.resolve(a2.request('/', { headers: { 'X-API-Key': k2.key } }))).status).toBe(401);
  });

  it('enforces the environment (test keys are refused by live services)', async () => {
    const { app, test, live } = setup({ environment: 'live' });
    const r = await call(app, { 'X-API-Key': test.key });
    expect(r.status).toBe(401);
    expect((await json(r)).error.message).toMatch(/test keys/);
    expect((await call(app, { 'X-API-Key': live.key })).status).toBe(200);
  });

  it('refuses a key whose prefix env disagrees with the stored record', async () => {
    const store = new InMemoryApiKeyStore();
    const k = generateApiKey('test');
    const relabelled = k.key.replace('bsh_test_', 'bsh_live_');
    store.add({ id: 'x', hash: hashApiKey(relabelled), env: 'test', scopes: [] });
    const app = new Hono().use(apiKeys({ store })).get('/', (c) => c.text('ok'));
    expect((await Promise.resolve(app.request('/', { headers: { 'X-API-Key': relabelled } }))).status).toBe(401);
  });

  it('403 insufficient_scope when a required scope is missing', async () => {
    const { app, test, live } = setup({ scopes: ['orders:write'] });
    const r = await call(app, { 'X-API-Key': test.key });
    expect(r.status).toBe(403);
    expect((await json(r)).error.code).toBe('insufficient_scope');
    expect(r.headers.get('WWW-Authenticate')).toContain('insufficient_scope');
    expect((await call(app, { 'X-API-Key': live.key })).status).toBe(200);
  });

  it('per-key quota counters: 429 quota_exceeded, reset per window, independent per key', async () => {
    let t = 10_000;
    const { app, live, store } = setup({ now: () => t }, { limit: 2, windowMs: 60_000 });
    const k = { 'X-API-Key': live.key };
    const r1 = await call(app, k);
    expect(r1.headers.get('X-Quota-Remaining')).toBe('1');
    expect(r1.headers.get('X-Quota-Limit')).toBe('2');
    expect((await call(app, k)).status).toBe(200);
    const over = await call(app, k);
    expect(over.status).toBe(429);
    expect((await json(over)).error.code).toBe('quota_exceeded');
    expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
    t = 60_000; // next fixed window
    expect((await call(app, k)).status).toBe(200);
    expect(await store.incrementUsage('other', 0, 1000)).toBe(1);
  });

  it('never passes the raw key to the store', async () => {
    const seen: string[] = [];
    const inner = new InMemoryApiKeyStore();
    const k = generateApiKey('live');
    inner.add({ id: 'x', hash: k.hash, env: 'live', scopes: [] });
    const spy: ApiKeyStore = {
      findByHash: async (h) => {
        seen.push(h);
        return inner.findByHash(h);
      },
      incrementUsage: (...a) => inner.incrementUsage(...a),
    };
    const app = new Hono().use(apiKeys({ store: spy })).get('/', (c) => c.text('ok'));
    expect((await Promise.resolve(app.request('/', { headers: { 'X-API-Key': k.key } }))).status).toBe(200);
    expect(seen).toEqual([k.hash]);
  });
});
