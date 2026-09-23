import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { EdgeError, jsonErrorHandler, jsonErrors, jsonNotFound, requestId } from '../src/index.js';
import { json } from './helpers.js';

function app(onUnexpected?: (e: Error) => void) {
  const a = new Hono();
  a.use(requestId({ generator: () => 'req-00000001' }));
  a.use(jsonErrors(onUnexpected ? { onUnexpected } : {}));
  a.onError(jsonErrorHandler());
  a.get('/boom', () => {
    throw new Error('db password is hunter2');
  });
  a.get('/edge', () => {
    throw new EdgeError(422, 'validation_failed', 'amount must be positive', { 'X-Extra': '1' });
  });
  a.get('/http', () => {
    throw new HTTPException(401, { message: 'token expired' });
  });
  a.get('/http500', () => {
    throw new HTTPException(503, { message: 'upstream secret detail' });
  });
  a.get('/text418', (c) => c.text('I am a teapot', 418));
  a.get('/text429', (c) => c.text('slow down', 429, { 'Retry-After': '7' }));
  a.get('/json400', (c) => c.json({ custom: true }, 400));
  a.get('/ok', (c) => c.json({ ok: true }));
  return a;
}

describe('jsonErrors()', () => {
  it('turns unexpected errors into an opaque 500 with the request id', async () => {
    const spy = vi.fn();
    const res = await app(spy).request('/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const body = await json(res);
    expect(body).toEqual({ error: { code: 'internal_error', message: 'Internal server error', requestId: 'req-00000001' } });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(spy).toHaveBeenCalledOnce();
    expect(res.headers.get('X-Request-Id')).toBe('req-00000001');
  });

  it('renders EdgeError code/message/status/headers', async () => {
    const res = await app().request('/edge');
    expect(res.status).toBe(422);
    expect(res.headers.get('X-Extra')).toBe('1');
    expect((await json(res)).error).toMatchObject({ code: 'validation_failed', message: 'amount must be positive' });
  });

  it('maps HTTPException: 4xx message kept, 5xx message hidden', async () => {
    expect((await json(await app().request('/http'))).error).toMatchObject({ code: 'unauthorized', message: 'token expired' });
    const r = await app().request('/http500');
    expect(r.status).toBe(503);
    expect((await json(r)).error).toMatchObject({ code: 'unavailable', message: 'Service unavailable' });
  });

  it('rewrites non-JSON error responses (incl. the default 404) and keeps Retry-After', async () => {
    const nf = await app().request('/nope');
    expect(nf.status).toBe(404);
    expect(await json(nf)).toEqual({ error: { code: 'not_found', message: 'Not found', requestId: 'req-00000001' } });
    const t = await app().request('/text418');
    expect(t.status).toBe(418);
    expect((await json(t)).error.code).toBe('error');
    const rl = await app().request('/text429');
    expect(rl.headers.get('Retry-After')).toBe('7');
    expect((await json(rl)).error.code).toBe('rate_limited');
  });

  it('leaves JSON error bodies and successes alone', async () => {
    expect(await (await app().request('/json400')).json()).toEqual({ custom: true });
    expect(await (await app().request('/ok')).json()).toEqual({ ok: true });
  });

  it('jsonErrorHandler / jsonNotFound work without the middleware', async () => {
    const a = new Hono();
    a.onError(jsonErrorHandler());
    a.notFound(jsonNotFound());
    a.get('/boom', () => {
      throw new Error('x');
    });
    expect(await json(await a.request('/boom'))).toEqual({ error: { code: 'internal_error', message: 'Internal server error', requestId: null } });
    expect((await json(await a.request('/missing'))).error.code).toBe('not_found');
  });
});
