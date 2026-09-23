import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { corsAllowlist } from '../src/index.js';

const ORIGIN = 'https://app.example.com';
function app(opts: Parameters<typeof corsAllowlist>[1] = {}, origins = [ORIGIN, 'http://localhost:5173']) {
  const a = new Hono();
  a.use(corsAllowlist(origins, opts));
  a.get('/data', (c) => c.json({ ok: true }));
  a.post('/data', (c) => c.json({ ok: true }));
  return a;
}
const preflight = (origin: string) => ({
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
});

describe('corsAllowlist()', () => {
  it('allows exactly-matching origins', async () => {
    const res = await app().request('/data', { headers: { Origin: ORIGIN } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toContain('Origin');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id');
  });

  it.each([
    'https://evil.com',
    'https://app.example.com.evil.com',
    'https://evilapp.example.com',
    'http://app.example.com',
    'https://app.example.com:8443',
    'https://APP.example.com',
    'null',
  ])('denies %s (no CORS headers, still Vary: Origin)', async (origin) => {
    const res = await app().request('/data', { headers: { Origin: origin } });
    expect(res.status).toBe(200); // CORS is enforced by the browser; we just never grant it
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('answers allowed preflights with 204 and the configured policy', async () => {
    const res = await app({ credentials: true, maxAge: 60 }).request('/data', preflight(ORIGIN));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('60');
  });

  it('rejects disallowed preflights with 403 JSON and no CORS headers', async () => {
    const res = await app().request('/data', preflight('https://evil.com'));
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('cors_origin_denied');
  });

  it('default deny: an empty allowlist grants nothing', async () => {
    const res = await app({}, []).request('/data', { headers: { Origin: ORIGIN } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('wildcard is allowed only without credentials, and never reflects the origin', async () => {
    expect(() => corsAllowlist(['*'], { credentials: true })).toThrow(/credentials/);
    const res = await app({}, ['*']).request('/data', { headers: { Origin: 'https://anyone.com' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it.each(['https://app.example.com/', 'app.example.com', 'https://app.example.com/path', 'https://*.example.com', 'null'])(
    'refuses misconfigured origin %s at construction',
    (o) => {
      expect(() => corsAllowlist([o])).toThrow();
    },
  );

  it('requests without Origin pass untouched', async () => {
    const res = await app().request('/data');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
