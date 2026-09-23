import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryRateLimitStore, rateLimit, trustProxy, type RateLimitOptions } from '../src/index.js';
import { json, peer } from './helpers.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
function app(opts: Partial<RateLimitOptions> & { windowMs?: number; max?: number } = {}) {
  const a = new Hono();
  a.use(rateLimit({ windowMs: 60_000, max: 3, ...opts }));
  a.get('/', (c) => c.text('ok'));
  return a;
}
const hit = (a: Hono, ip = '198.51.100.1', headers: Record<string, string> = {}) => Promise.resolve(a.request('/', { headers }, peer(ip)));

describe('rateLimit() token bucket', () => {
  it('allows a burst of max, then 429 with Retry-After and JSON body', async () => {
    const c = clock();
    const a = app({ now: c.now });
    for (let i = 0; i < 3; i++) {
      const r = await hit(a);
      expect(r.status).toBe(200);
      expect(r.headers.get('RateLimit-Remaining')).toBe(String(2 - i));
      expect(r.headers.get('RateLimit-Limit')).toBe('3');
      expect(r.headers.get('RateLimit-Policy')).toBe('3;w=60');
    }
    const r = await hit(a);
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('20'); // one token per 20s
    expect((await json(r)).error.code).toBe('rate_limited');
  });

  it('refills continuously', async () => {
    const c = clock();
    const a = app({ now: c.now });
    for (let i = 0; i < 3; i++) await hit(a);
    expect((await hit(a)).status).toBe(429);
    c.advance(19_999);
    expect((await hit(a)).status).toBe(429);
    c.advance(1);
    expect((await hit(a)).status).toBe(200);
    expect((await hit(a)).status).toBe(429);
    c.advance(60_000);
    for (let i = 0; i < 3; i++) expect((await hit(a)).status).toBe(200);
  });

  it('isolates keys (per client IP)', async () => {
    const a = app({ now: clock().now, max: 1 });
    expect((await hit(a, '198.51.100.1')).status).toBe(200);
    expect((await hit(a, '198.51.100.1')).status).toBe(429);
    expect((await hit(a, '198.51.100.2')).status).toBe(200);
  });

  it('cannot be bypassed with a spoofed X-Forwarded-For when trustProxy is not configured', async () => {
    const a = app({ now: clock().now, max: 1 });
    expect((await hit(a, '198.51.100.1', { 'X-Forwarded-For': '1.1.1.1' })).status).toBe(200);
    expect((await hit(a, '198.51.100.1', { 'X-Forwarded-For': '2.2.2.2' })).status).toBe(429);
  });

  it('uses the proxy-resolved client IP when trustProxy is configured', async () => {
    const a = new Hono();
    a.use(trustProxy({ hops: 1 }));
    a.use(rateLimit({ windowMs: 60_000, max: 1, now: clock().now }));
    a.get('/', (c) => c.text('ok'));
    expect((await hit(a, '10.0.0.1', { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(200);
    expect((await hit(a, '10.0.0.1', { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(200);
    expect((await hit(a, '10.0.0.1', { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(429);
  });

  it('apiKey keying uses the authenticated key and falls back to ip', async () => {
    const a = new Hono();
    a.use(async (c, next) => {
      const id = c.req.header('X-Test-Key');
      if (id) c.set('apiKey', { id, env: 'test', scopes: [] });
      await next();
    });
    a.use(rateLimit({ windowMs: 60_000, max: 1, key: 'apiKey', now: clock().now }));
    a.get('/', (c) => c.text('ok'));
    expect((await hit(a, '198.51.100.1', { 'X-Test-Key': 'k1' })).status).toBe(200);
    expect((await hit(a, '198.51.100.2', { 'X-Test-Key': 'k1' })).status).toBe(429); // same key, other IP
    expect((await hit(a, '198.51.100.1', { 'X-Test-Key': 'k2' })).status).toBe(200);
    expect((await hit(a, '198.51.100.1')).status).toBe(200); // anonymous -> ip bucket
    expect((await hit(a, '198.51.100.1')).status).toBe(429);
  });

  it('custom keys, costs, shared stores with prefixes', async () => {
    const store = new InMemoryRateLimitStore();
    const c = clock();
    const a = new Hono();
    a.use('/a', rateLimit({ windowMs: 1000, max: 10, store, prefix: 'a', key: (ctx) => ctx.req.header('X-User'), cost: 5, now: c.now }));
    a.use('/b', rateLimit({ windowMs: 1000, max: 10, store, prefix: 'b', key: (ctx) => ctx.req.header('X-User'), now: c.now }));
    a.get('/a', (ctx) => ctx.text('a'));
    a.get('/b', (ctx) => ctx.text('b'));
    const get = (p: string, u: string) => Promise.resolve(a.request(p, { headers: { 'X-User': u } }, peer('198.51.100.1'))).then((r) => r.status);
    expect(await get('/a', 'u1')).toBe(200);
    expect(await get('/a', 'u1')).toBe(200);
    expect(await get('/a', 'u1')).toBe(429);
    expect(await get('/b', 'u1')).toBe(200); // separate namespace
    expect(await get('/a', 'u2')).toBe(200);
    expect(store.size).toBe(3);
  });

  it('in-memory store stays bounded', async () => {
    const store = new InMemoryRateLimitStore({ maxKeys: 5 });
    const rule = { capacity: 2, refillPerMs: 0.001 };
    for (let i = 0; i < 50; i++) await store.take(`k${i}`, 1, rule, 0);
    expect(store.size).toBeLessThanOrEqual(5);
  });

  it('can omit headers and validates options', async () => {
    const r = await hit(app({ headers: false }));
    expect(r.headers.get('RateLimit-Limit')).toBeNull();
    expect(() => rateLimit({ windowMs: 0, max: 1 })).toThrow();
    expect(() => rateLimit({ windowMs: 1000, max: 0 })).toThrow();
  });
});
