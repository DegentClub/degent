import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  InMemoryApiKeyStore,
  apiKeys,
  bodyLimit,
  corsAllowlist,
  generateApiKey,
  jsonErrorHandler,
  jsonErrors,
  rateLimit,
  requestId,
  securityHeaders,
  trustProxy,
} from '../src/index.js';
import { peer } from './helpers.js';

describe('full edge stack (recommended order)', () => {
  const store = new InMemoryApiKeyStore();
  const key = generateApiKey('live');
  store.add({ id: 'k', hash: key.hash, env: 'live', scopes: ['read'] });

  const app = new Hono();
  app.onError(jsonErrorHandler());
  app.use(requestId());
  app.use(jsonErrors());
  app.use(securityHeaders());
  app.use(corsAllowlist(['https://app.example.com'], { credentials: true }));
  app.use(trustProxy({ trusted: ['10.0.0.0/8'] }));
  app.use(rateLimit({ windowMs: 60_000, max: 100 }));
  app.use(bodyLimit(1024));
  app.use('/v1/*', apiKeys({ store, scopes: ['read'], environment: 'live' }));
  app.use('/v1/*', rateLimit({ windowMs: 60_000, max: 2, key: 'apiKey', prefix: 'key' }));
  app.get('/v1/thing', (c) => c.json({ ok: true, key: c.get('apiKey').id }));
  app.get('/v1/boom', () => {
    throw new Error('secret');
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    Promise.resolve(app.request(path, { headers: { Origin: 'https://app.example.com', ...headers } }, peer('10.0.0.1')));

  it('success responses carry request id, CORS, security and rate-limit headers', async () => {
    const res = await get('/v1/thing', { 'X-API-Key': key.key, 'X-Forwarded-For': '198.51.100.20' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('RateLimit-Limit')).toBeTruthy();
  });

  it('every failure is uniform JSON with the same request id as the header, and keeps CORS/security headers', async () => {
    const cases: [string, Record<string, string>, number, string][] = [
      ['/v1/thing', {}, 401, 'missing_api_key'],
      ['/v1/boom', { 'X-API-Key': key.key, 'X-Forwarded-For': '198.51.100.21' }, 500, 'internal_error'],
      ['/nope', {}, 404, 'not_found'],
    ];
    for (const [path, headers, status, code] of cases) {
      const res = await get(path, headers);
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe(code);
      expect(body.error.requestId).toBe(res.headers.get('X-Request-Id'));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    }
  });

  it('per-key limiter trips independently of the IP limiter', async () => {
    const s2 = new InMemoryApiKeyStore();
    const k2 = generateApiKey('live');
    s2.add({ id: 'k2', hash: k2.hash, env: 'live', scopes: ['read'] });
    const a = new Hono();
    a.use(requestId(), jsonErrors());
    a.use(apiKeys({ store: s2 }), rateLimit({ windowMs: 60_000, max: 1, key: 'apiKey' }));
    a.get('/', (c) => c.text('ok'));
    const h = { headers: { 'X-API-Key': k2.key } };
    expect((await Promise.resolve(a.request('/', h, peer('198.51.100.1')))).status).toBe(200);
    const r = await Promise.resolve(a.request('/', h, peer('198.51.100.2')));
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBeTruthy();
  });
});
