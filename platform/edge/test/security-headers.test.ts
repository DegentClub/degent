import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from '../src/index.js';

describe('securityHeaders()', () => {
  it('sets hardened API defaults', async () => {
    const app = new Hono().use(securityHeaders()).get('/', (c) => c.json({}));
    const res = await app.request('/');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Strict-Transport-Security')).toMatch(/max-age=\d+; includeSubDomains/);
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('applies to error responses and raw Responses, and strips X-Powered-By / Server', async () => {
    const app = new Hono().use(securityHeaders());
    app.get('/raw', () => new Response('x', { headers: { 'X-Powered-By': 'Express', Server: 'nginx/1.2' } }));
    const res = await app.request('/raw');
    expect(res.headers.get('X-Powered-By')).toBeNull();
    expect(res.headers.get('Server')).toBeNull();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const nf = await app.request('/missing');
    expect(nf.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('allows overrides and disabling, keeps handler Cache-Control', async () => {
    const app = new Hono()
      .use(securityHeaders({ contentSecurityPolicy: "default-src 'self'", frameOptions: false, strictTransportSecurity: false }))
      .get('/', (c) => c.json({}, 200, { 'Cache-Control': 'public, max-age=60' }));
    const res = await app.request('/');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
