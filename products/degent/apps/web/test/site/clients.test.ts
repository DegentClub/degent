import { describe, expect, it } from 'vitest';
import { createHttpAtelier } from '../../src/site/services/real/atelier';
import { createOrdService, parseInscription } from '../../src/site/services/real/ord';
import { AtelierError } from '../../src/site/services/types';

type Call = { url: string; init: RequestInit };

function fakeFetch(routes: Record<string, (init: RequestInit) => Response>, calls: Call[]) {
  return async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? 'GET'} ${url.replace('https://a.test', '')}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { code: 'not_found', message: key, requestId: null } }), { status: 404 });
    return h(init);
  };
}

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('HTTP Atelier client (contracts/openapi/degent-atelier.yaml)', () => {
  const token = `atl_${'x'.repeat(43)}`;
  it('opens an anonymous session once and sends it as a bearer token', async () => {
    const calls: Call[] = [];
    const a = createHttpAtelier({
      baseUrl: 'https://a.test',
      fetch: fakeFetch(
        {
          'POST /v1/sessions': () => json({ sessionId: 's', token, expiresAt: '2026-09-25T00:00:00Z', quota: { dailyImages: 12, usedToday: 0 } }, 201),
          'POST /v1/generate': () => json({ jobId: 'job_1', status: 'queued', statusUrl: '/v1/jobs/job_1', quota: { dailyImages: 12, usedToday: 2 } }, 202),
          'GET /v1/jobs/job_1': () =>
            json({ id: 'job_1', status: 'done', tier: 'standard', placard: 'DEGEN', brief: 'b', variations: 1, provider: 'fake', createdAt: '', startedAt: null, finishedAt: null, error: null, candidates: [{ id: 'cand_1', previewUrl: '/v1/candidates/cand_1/preview', width: 512, height: 512, providerRef: 'x', review: null }] }),
        },
        calls,
      ),
    });
    const r = await a.generate({ brief: 'DJ', placard: 'DEGEN', tier: 'standard', variations: 2 });
    expect(r).toEqual({ jobId: 'job_1', quota: { dailyImages: 12, usedToday: 2 } });
    const job = await a.getJob('job_1');
    expect(job.candidates[0]!.previewUrl).toBe('https://a.test/v1/candidates/cand_1/preview');
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://a.test/v1/sessions',
      'POST https://a.test/v1/generate',
      'GET https://a.test/v1/jobs/job_1',
    ]);
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ brief: 'DJ', placard: 'DEGEN', tier: 'standard', variations: 2 });
  });

  it('maps contract errors with Retry-After', async () => {
    const a = createHttpAtelier({
      baseUrl: 'https://a.test',
      fetch: fakeFetch(
        {
          'POST /v1/sessions': () => json({ sessionId: 's', token, expiresAt: '', quota: { dailyImages: 1, usedToday: 1 } }, 201),
          'POST /v1/generate': () => json({ error: { code: 'rate_limited', message: 'Too many', requestId: 'r' } }, 429, { 'retry-after': '9' }),
        },
        [],
      ),
    });
    const e = (await a.generate({ brief: 'abc', placard: 'DEGEN', tier: 'standard', variations: 1 }).catch((x) => x)) as AtelierError;
    expect(e).toBeInstanceOf(AtelierError);
    expect(e).toMatchObject({ code: 'rate_limited', status: 429, retryAfterSeconds: 9 });
  });

  it('upload sends octet-stream with tier/placard/frame query; content is fetched by hash', async () => {
    const calls: Call[] = [];
    const sha = 'a'.repeat(64);
    const a = createHttpAtelier({
      baseUrl: 'https://a.test',
      fetch: fakeFetch(
        {
          'POST /v1/sessions': () => json({ sessionId: 's', token, expiresAt: '', quota: { dailyImages: 1, usedToday: 0 } }, 201),
          'POST /v1/upload?tier=large&frame=true&placard=REGEN': () => json({ uploadId: 'u', framed: true, transformed: true, tier: 'large', placard: 'REGEN', contentSha256: sha, contentLength: 3, contentType: 'image/jpeg', width: 1, height: 1, review: { approved: true, reasons: [], checks: [] }, downloadUrl: '' }),
          [`GET /v1/content/${sha}`]: () => new Response(new Uint8Array([1, 2, 3])),
        },
        calls,
      ),
    });
    await a.upload(new Blob([new Uint8Array([9])]), { tier: 'large', placard: 'REGEN', frame: true });
    expect(new Headers(calls[1]!.init.headers).get('content-type')).toBe('application/octet-stream');
    expect(await a.getContent(sha)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(a.getContent('nope')).rejects.toThrow(/bad content hash/);
  });

  it('not configured → not_configured, without any request', async () => {
    const a = createHttpAtelier({ baseUrl: '' });
    expect(a.configured).toBe(false);
    await expect(a.health()).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('ord client', () => {
  it('parses the JSON inscription (unix timestamp) and caches per id', async () => {
    const id = `${'e'.repeat(64)}i0`;
    const calls: string[] = [];
    const ord = createOrdService({
      baseUrl: 'https://ord.test',
      fetch: async (u, init) => {
        calls.push(u);
        expect(new Headers(init?.headers).get('accept')).toBe('application/json');
        return json({ id, number: 5, address: 'bc1p...', content_type: 'image/jpeg', content_length: 300000, timestamp: 1700000000, height: 820000, fee: 12345 });
      },
    });
    ord.prefetch(id);
    const d = await ord.getInscription(id);
    await ord.getInscription(id);
    expect(calls).toEqual([`https://ord.test/inscription/${id}`]);
    expect(d).toEqual({ id, number: 5, address: 'bc1p...', contentType: 'image/jpeg', contentLength: 300000, timestamp: '2023-11-14T22:13:20.000Z', height: 820000, fee: 12345 });
    expect(ord.contentUrl(id)).toBe(`https://ord.test/content/${id}`);
  });

  it('tolerates missing fields', () => {
    expect(parseInscription('x', {})).toMatchObject({ id: 'x', address: null, fee: null, timestamp: null });
  });
});
