import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyLimit } from '../src/index.js';

function app(limit = 16) {
  const a = new Hono();
  a.use(bodyLimit(limit));
  a.post('/', async (c) => c.json({ len: (await c.req.text()).length }));
  return a;
}
const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const ch of chunks) ctrl.enqueue(new TextEncoder().encode(ch));
      ctrl.close();
    },
  });

describe('bodyLimit()', () => {
  it('passes bodies up to the limit', async () => {
    const res = await app().request('/', { method: 'POST', body: 'x'.repeat(16) });
    expect(await res.json()).toEqual({ len: 16 });
  });

  it('rejects a declared Content-Length over the limit with 413 JSON', async () => {
    const res = await app().request('/', { method: 'POST', body: 'x'.repeat(17) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('payload_too_large');
  });

  it('counts streamed (chunked) bodies and still lets the handler read them', async () => {
    const ok = await app().request('/', { method: 'POST', body: stream(['abcd', 'efgh']), duplex: 'half' } as RequestInit);
    expect(await ok.json()).toEqual({ len: 8 });
    const big = await app().request('/', { method: 'POST', body: stream(['x'.repeat(10), 'y'.repeat(10)]), duplex: 'half' } as RequestInit);
    expect(big.status).toBe(413);
  });

  it('rejects a garbage Content-Length', async () => {
    const req = new Request('http://x/', { method: 'POST', body: 'hi', headers: { 'Content-Length': 'abc' } });
    const res = await app().request(req);
    expect([400, 413]).toContain(res.status);
  });

  it('ignores bodyless requests and validates its argument', async () => {
    const a = new Hono().use(bodyLimit(0)).get('/', (c) => c.text('ok'));
    expect((await a.request('/')).status).toBe(200);
    expect(() => bodyLimit(-1)).toThrow();
  });
});
