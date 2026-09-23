import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestId } from '../src/index.js';

describe('requestId()', () => {
  it('generates a UUID, exposes it on the context and the response', async () => {
    const app = new Hono();
    app.use(requestId());
    app.get('/', (c) => c.json({ id: c.get('requestId') }));
    const res = await app.request('/');
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('X-Request-Id')).toBe(body.id);
  });

  it('ignores client-supplied ids by default', async () => {
    const app = new Hono().use(requestId()).get('/', (c) => c.text(c.get('requestId')));
    const res = await app.request('/', { headers: { 'X-Request-Id': 'attacker-chosen-id' } });
    expect(await res.text()).not.toBe('attacker-chosen-id');
  });

  it('reuses well-formed incoming ids when trusted, rejects malformed ones', async () => {
    const app = new Hono().use(requestId({ trustIncoming: true })).get('/', (c) => c.text(c.get('requestId')));
    expect(await (await app.request('/', { headers: { 'X-Request-Id': 'lb-1234abcd' } })).text()).toBe('lb-1234abcd');
    const evil = await (await app.request('/', { headers: { 'X-Request-Id': 'x <script>alert(1)</script>' } })).text();
    expect(evil).toMatch(/^[0-9a-f-]{36}$/);
    const long = await (await app.request('/', { headers: { 'X-Request-Id': 'a'.repeat(200) } })).text();
    expect(long).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets the header on raw Response objects and custom header names', async () => {
    const app = new Hono().use(requestId({ header: 'X-Correlation-Id', generator: () => 'fixed-id-123' }));
    app.get('/', () => new Response('raw'));
    const res = await app.request('/');
    expect(res.headers.get('X-Correlation-Id')).toBe('fixed-id-123');
  });
});
