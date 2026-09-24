import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsContentStore } from '../src/adapters/content-store.js';
import { SqliteStateStore } from '../src/adapters/state-store.js';
import { compose, sha256Hex } from '../src/compose.js';
import { FakeImageProvider } from '../src/providers/fake.js';
import type { ArtReview } from '../src/review.js';
import { auth, jsonInit, makeHarness, type Harness, type ReqInit } from './fakes/harness.js';

type Json = Record<string, any>;
const body = async (r: Response): Promise<Json> => (await r.json()) as Json;

async function generateAndRun(h: Harness, token: string, req: Json = {}): Promise<Json> {
  const res = await h.req('/v1/generate', jsonInit(token, { brief: 'DJ at a rooftop party', placard: 'DEGENT', tier: 'standard', ...req }));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(202);
  const { jobId } = await body(res);
  await h.service.tick();
  const job = await body(await h.req(`/v1/jobs/${jobId}`, { headers: auth(token) }));
  return job;
}

describe('sessions and auth', () => {
  it('issues an anonymous bearer token, stores only its hash, and requires it on paid endpoints', async () => {
    const h = makeHarness();
    const res = await h.req('/v1/sessions', { method: 'POST' });
    expect(res.status).toBe(201);
    const s = await body(res);
    expect(s.token).toMatch(/^atl_/);
    expect(s.quota).toEqual({ dailyImages: 8, usedToday: 0 });
    expect(JSON.stringify([...h.state.sessions.values()])).not.toContain(s.token);

    for (const [path, init] of [
      ['/v1/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/v1/jobs/abcdefgh1234', {}],
      ['/v1/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(10) }],
    ] as const) {
      const r = await h.req(path, init as RequestInit);
      expect(r.status, path).toBe(401);
      expect((await body(r)).error.code).toBe('unauthorized');
    }
    const bad = await h.req('/v1/generate', jsonInit('atl_' + 'x'.repeat(43), { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard' }));
    expect(bad.status).toBe(401);
  });

  it('expires sessions and caps sessions per IP per day', async () => {
    const h = makeHarness({ quotas: { sessionsPerIpPerDay: 2, sessionTtlHours: 1 } });
    const t = await h.session('203.0.113.1');
    await h.session('203.0.113.1');
    const third = await h.req('/v1/sessions', { method: 'POST', ip: '203.0.113.1' });
    expect(third.status).toBe(429);
    expect((await body(third)).error.code).toBe('quota_exceeded');
    expect((await h.req('/v1/sessions', { method: 'POST', ip: '203.0.113.2' })).status).toBe(201);
    h.clock.advance(2 * 3_600_000);
    expect((await h.req('/v1/jobs/abcdefgh1234', { headers: auth(t) })).status).toBe(401);
  });
});

describe('generation job lifecycle (fake provider)', () => {
  it('queues, runs in the worker, lists candidates with previews, finalises, and serves byte-exact content', async () => {
    const h = makeHarness();
    const token = await h.session();
    const res = await h.req('/v1/generate', jsonInit(token, { brief: 'pharaoh', mood: 'regal', placard: 'REGEN', tier: 'standard', variations: 2 }));
    expect(res.status).toBe(202);
    const accepted = await body(res);
    expect(accepted).toMatchObject({ status: 'queued', statusUrl: `/v1/jobs/${accepted.jobId}`, quota: { dailyImages: 8, usedToday: 2 } });

    const queued = await body(await h.req(`/v1/jobs/${accepted.jobId}`, { headers: auth(token) }));
    expect(queued.status).toBe('queued');
    expect(queued.candidates).toEqual([]);

    expect(await h.service.tick()).toBe(1);
    const job = await body(await h.req(`/v1/jobs/${accepted.jobId}`, { headers: auth(token) }));
    expect(job.status).toBe('done');
    expect(job.provider).toBe('fake');
    expect(job.candidates).toHaveLength(2);
    const cand = job.candidates[0];
    expect(cand).toMatchObject({ width: 1024, height: 1024, previewUrl: `/v1/candidates/${cand.id}/preview`, review: null });

    const pv = await h.req(cand.previewUrl);
    expect(pv.status).toBe(200);
    expect(pv.headers.get('content-type')).toBe('image/jpeg');
    expect((await sharp(Buffer.from(await pv.arrayBuffer())).metadata()).width).toBe(512);

    const fin = await h.req(`/v1/candidates/${cand.id}/finalize`, jsonInit(token, { tier: 'standard', placard: 'REGEN' }));
    expect(fin.status).toBe(200);
    const f = await body(fin);
    expect(f).toMatchObject({ candidateId: cand.id, tier: 'standard', placard: 'REGEN', contentType: 'image/jpeg', downloadUrl: `/v1/content/${f.contentSha256}` });
    expect(f.contentLength).toBeGreaterThanOrEqual(200_000);
    expect(f.contentLength).toBeLessThanOrEqual(400_000);
    expect(f.review.approved).toBe(true);

    // Content-addressed retrieval is byte-exact: what the mint front end PUTs is what was reviewed.
    const content = await h.req(f.downloadUrl);
    expect(content.status).toBe(200);
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(bytes.length).toBe(f.contentLength);
    expect(sha256Hex(bytes)).toBe(f.contentSha256);
    expect(content.headers.get('etag')).toBe(`"${f.contentSha256}"`);
    expect(content.headers.get('cache-control')).toContain('immutable');
    expect(content.headers.get('content-length')).toBe(String(f.contentLength));

    // Finalising again with the same options is idempotent (same bytes, same address).
    const again = await body(await h.req(`/v1/candidates/${cand.id}/finalize`, jsonInit(token, { tier: 'standard', placard: 'REGEN' })));
    expect(again.contentSha256).toBe(f.contentSha256);

    // Ledger: one entry, settled at the per-image cost.
    const ledger = await h.state.entriesForSession([...h.state.sessions.values()][0]!.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: 'settled', images: 2, costCents: 8, provider: 'fake' });
  });

  it('keeps jobs and candidates private to their session', async () => {
    const h = makeHarness();
    const a = await h.session();
    const b = await h.session();
    const job = await generateAndRun(h, a);
    expect((await h.req(`/v1/jobs/${job.id}`, { headers: auth(b) })).status).toBe(404);
    const fin = await h.req(`/v1/candidates/${job.candidates[0].id}/finalize`, jsonInit(b, { tier: 'standard', placard: 'DEGEN' }));
    expect(fin.status).toBe(404);
  });

  it('validates the request with every problem listed', async () => {
    const h = makeHarness();
    const token = await h.session();
    const r = await h.req('/v1/generate', jsonInit(token, { brief: 'x', placard: 'DEGENERATE', tier: 'huge', variations: 9 }));
    expect(r.status).toBe(422);
    const e = await body(r);
    expect(e.error.code).toBe('validation_failed');
    expect(e.error.details.problems).toEqual(expect.arrayContaining(['placard must be one of DEGEN, DEGENT, REGEN', 'tier must be one of standard, large, fullblock', 'variations must be an integer 1..4']));
    const banned = await h.req('/v1/generate', jsonInit(token, { brief: 'gore party', placard: 'DEGEN', tier: 'standard' }));
    expect((await body(banned)).error.details.problems[0]).toMatch(/disallowed terms: gore/);
    const notJson = await h.req('/v1/generate', { method: 'POST', headers: auth(token, { 'content-type': 'text/plain' }), body: 'hi' });
    expect(notJson.status).toBe(415);
    const finBad = await h.req('/v1/candidates/abcdefgh1234/finalize', jsonInit(token, { tier: 'standard', placard: 'DEGEN' }));
    expect(finBad.status).toBe(404);
  });

  it('a provider failure fails the job with a safe message and does not count against the quota or the budget', async () => {
    const h = makeHarness({ provider: new FakeImageProvider({ costCents: 4, failWith: 'upstream 500: {"error":"sk-live-SECRETKEY123456 exploded"}' }), quotas: { sessionDailyImages: 2 } });
    const token = await h.session();
    const job = await generateAndRun(h, token, { variations: 2 });
    expect(job.status).toBe('failed');
    expect(job.error).toEqual({ code: 'job_failed', message: 'generation failed' });
    expect(JSON.stringify(job)).not.toContain('SECRET');
    const s = [...h.state.sessions.values()][0]!;
    expect((await h.state.entriesForSession(s.id))[0]).toMatchObject({ status: 'failed', costCents: 0 });
    // quota released: another 2-image job is accepted
    expect((await h.req('/v1/generate', jsonInit(token, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard', variations: 2 }))).status).toBe(202);
  });
});

describe('quotas and cost caps', () => {
  it('enforces the per-session daily image quota and resets at 00:00 UTC', async () => {
    const h = makeHarness({ quotas: { sessionDailyImages: 3 } });
    const token = await h.session();
    const gen = (n: number) => h.req('/v1/generate', jsonInit(token, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard', variations: n }));
    expect((await gen(2)).status).toBe(202);
    const over = await gen(2);
    expect(over.status).toBe(429);
    expect((await body(over)).error).toMatchObject({ code: 'quota_exceeded', message: 'daily generation quota is 3 images per session (2 used)' });
    expect((await gen(1)).status).toBe(202);
    expect((await gen(1)).status).toBe(429);
    h.clock.advance(13 * 3_600_000); // 12:00 -> 01:00 next day
    expect((await gen(3)).status).toBe(202);
  });

  it('enforces the global daily cost cap across sessions, reserving cost before the provider is called', async () => {
    const h = makeHarness({ quotas: { globalDailyCostCents: 20 } }); // fake provider costs 4c/image
    const a = await h.session();
    const b = await h.session();
    expect((await h.req('/v1/generate', jsonInit(a, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard', variations: 4 }))).status).toBe(202); // 16c reserved, not yet run
    const capped = await h.req('/v1/generate', jsonInit(b, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard', variations: 2 })); // 16 + 8 > 20
    expect(capped.status).toBe(503);
    expect((await body(capped)).error.code).toBe('cost_cap_reached');
    expect((await h.req('/v1/generate', jsonInit(b, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard', variations: 1 }))).status).toBe(202); // 20 <= 20
    const health = await body(await h.req('/v1/health'));
    expect(health).toMatchObject({ status: 'degraded', spentTodayCents: 20, dailyCostCapCents: 20 });
  });

  it('a zero cost cap disables live generation; the fake provider (0c) is unaffected by a cap of 0 only when it is free', async () => {
    const h = makeHarness({ quotas: { globalDailyCostCents: 0 } });
    const t = await h.session();
    expect((await h.req('/v1/generate', jsonInit(t, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard' }))).status).toBe(503);
    const free = makeHarness({ provider: new FakeImageProvider(), quotas: { globalDailyCostCents: 0 } });
    const t2 = await free.session();
    expect((await free.req('/v1/generate', jsonInit(t2, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard' }))).status).toBe(202);
  });

  it('rate limits per session as well as per IP', async () => {
    const h = makeHarness({ sessionRateLimitPerMinute: 2, rateLimitPerMinute: 1000, quotas: { sessionDailyImages: 100 } });
    const a = await h.session();
    const b = await h.session();
    const gen = (t: string) => h.req('/v1/generate', jsonInit(t, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard' }));
    expect((await gen(a)).status).toBe(202);
    expect((await gen(a)).status).toBe(202);
    const limited = await gen(a);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await body(limited)).error.code).toBe('rate_limited');
    expect((await gen(b)).status).toBe(202); // same IP, different session: its own bucket

    const ip = makeHarness({ rateLimitPerMinute: 2 });
    await ip.session('192.0.2.9');
    await ip.session('192.0.2.9');
    expect((await ip.req('/v1/sessions', { method: 'POST', ip: '192.0.2.9' })).status).toBe(429);
  });
});

describe('upload path (bring your own art)', () => {
  let art: Uint8Array;
  beforeAll(async () => {
    const [img] = await new FakeImageProvider().generate({ prompt: 'my own art', size: '1024x1024', n: 1 });
    // a non-square JPEG, as people usually bring
    art = new Uint8Array(await sharp(Buffer.from(img!.bytes)).resize(1200, 900, { fit: 'fill' }).jpeg({ quality: 90 }).toBuffer());
  });

  it('frames an octet-stream upload, reviews it and stores it content-addressed', async () => {
    const h = makeHarness();
    const token = await h.session();
    const r = await h.req('/v1/upload?tier=standard&placard=DEGEN', { method: 'POST', headers: auth(token, { 'content-type': 'application/octet-stream' }), body: art });
    expect(r.status).toBe(200);
    const u = await body(r);
    expect(u).toMatchObject({ framed: true, transformed: true, tier: 'standard', placard: 'DEGEN', contentType: 'image/jpeg' });
    expect(u.width).toBe(u.height);
    const bytes = new Uint8Array(await (await h.req(u.downloadUrl)).arrayBuffer());
    expect(sha256Hex(bytes)).toBe(u.contentSha256);
  });

  it('accepts multipart/form-data with frame=false (crop to square + fit the tier)', async () => {
    const h = makeHarness();
    const token = await h.session();
    const form = new FormData();
    form.set('file', new Blob([Buffer.from(art)], { type: 'image/jpeg' }), 'mine.jpg');
    form.set('tier', 'large');
    form.set('frame', 'false');
    const r = await h.req('/v1/upload', { method: 'POST', headers: auth(token), body: form });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const u = await body(r);
    expect(u).toMatchObject({ framed: false, transformed: true, tier: 'large', placard: null });
    expect(u.contentLength).toBeGreaterThanOrEqual(400_001);
  });

  it('stores an already-compliant JPEG byte-for-byte when frame=false', async () => {
    const h = makeHarness();
    const token = await h.session();
    const ready = await compose(art, { tier: 'standard', frame: false });
    if (!ready.ok) throw new Error(ready.message);
    const r = await h.req('/v1/upload?tier=standard&frame=false', { method: 'POST', headers: auth(token, { 'content-type': 'image/jpeg' }), body: ready.bytes });
    const u = await body(r);
    expect(u).toMatchObject({ transformed: false, contentSha256: ready.sha256, contentLength: ready.contentLength });
  });

  it('rejects bad uploads with structured errors', async () => {
    const h = makeHarness();
    const token = await h.session();
    const up = (qs: string, init: ReqInit) => h.req(`/v1/upload${qs}`, { method: 'POST', ...init, headers: auth(token, (init.headers as Record<string, string>) ?? {}) });
    const noPlacard = await up('?tier=standard', { headers: { 'content-type': 'application/octet-stream' }, body: art });
    expect(noPlacard.status).toBe(422);
    expect((await body(noPlacard)).error.details.problems).toContain('placard must be one of DEGEN, DEGENT, REGEN when frame is true');
    const notImage = await up('?tier=standard&placard=DEGEN', { headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(5000).fill(1) });
    expect(notImage.status).toBe(415);
    expect((await body(notImage)).error.code).toBe('unsupported_media_type');
    const wrongCt = await up('?tier=standard&placard=DEGEN', { headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(wrongCt.status).toBe(415);
    const tooBig = await up('?tier=standard&placard=DEGEN', { headers: { 'content-type': 'application/octet-stream', 'content-length': String(8 * 1024 * 1024 + 1) }, body: new Uint8Array(8 * 1024 * 1024 + 1) });
    expect(tooBig.status).toBe(413);
    expect((await body(tooBig)).error.code).toBe('payload_too_large');
    const badFrame = await up('?tier=standard&placard=DEGEN&frame=maybe', { headers: { 'content-type': 'application/octet-stream' }, body: art });
    expect(badFrame.status).toBe(422);
  });

  it('surfaces a review rejection (e.g. the optional vision reviewer) as review_rejected', async () => {
    const vision: ArtReview = { name: 'vision', review: async () => ({ approved: false, reasons: ['no bow tie visible'], checks: [{ id: 'guidelines', passed: false, detail: 'no bow tie visible' }] }) };
    const h = makeHarness({ outputReview: vision });
    const token = await h.session();
    const r = await h.req('/v1/upload?tier=standard&placard=DEGEN', { method: 'POST', headers: auth(token, { 'content-type': 'application/octet-stream' }), body: art });
    expect(r.status).toBe(422);
    const e = await body(r);
    expect(e.error.code).toBe('review_rejected');
    expect(e.error.details.review.reasons).toEqual(['no bow tie visible']);
  });
});

describe('service endpoints and edge behaviour', () => {
  it('health says fake mode; config lists tiers and placards; 404s and CORS are structured', async () => {
    const h = makeHarness();
    const health = await body(await h.req('/v1/health'));
    expect(health.provider).toEqual({ name: 'fake', mode: 'fake' });
    expect(health.checks.find((c: Json) => c.id === 'provider').detail).toMatch(/fake mode/);
    const cfg = await body(await h.req('/v1/config'));
    expect(cfg.placards).toEqual(['DEGEN', 'DEGENT', 'REGEN']);
    expect(cfg.tiers.map((t: Json) => [t.minBytes, t.maxBytes])).toEqual([[200_000, 400_000], [400_001, 3_499_999], [3_500_000, 3_900_000]]);
    const nf = await h.req('/v1/nope');
    expect(nf.status).toBe(404);
    expect((await body(nf)).error.code).toBe('not_found');
    expect((await h.req('/v1/content/' + 'a'.repeat(64))).status).toBe(404);
    expect((await h.req('/v1/content/not-a-hash')).status).toBe(404);
    const pre = await h.req('/v1/generate', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(403);
    const ok = await h.req('/v1/generate', { method: 'OPTIONS', headers: { origin: 'https://degent.club', 'access-control-request-method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://degent.club');
    expect((await h.req('/v1/health')).headers.get('x-request-id')).toBeTruthy();
  });
});

describe('durable adapters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('sqlite state store: sessions, ledger sums and settlement survive a reopen', async () => {
    const path = join(dir, 'atelier.db');
    const s = new SqliteStateStore(path);
    await s.createSession({ id: 'sess1234', tokenHash: 'h'.repeat(64), createdAt: '2026-09-24T01:00:00.000Z', expiresAt: '2026-09-25T01:00:00.000Z', ip: '1.2.3.4' });
    await s.record({ id: 'l1', sessionId: 'sess1234', kind: 'generate', images: 3, costCents: 15, status: 'reserved', provider: 'openai:gpt-image-1', createdAt: '2026-09-24T02:00:00.000Z', updatedAt: '2026-09-24T02:00:00.000Z' });
    await s.record({ id: 'l2', sessionId: 'sess1234', kind: 'generate', images: 2, costCents: 10, status: 'reserved', provider: 'openai:gpt-image-1', createdAt: '2026-09-24T03:00:00.000Z', updatedAt: '2026-09-24T03:00:00.000Z' });
    await s.settle('l2', { status: 'failed', costCents: 0, updatedAt: '2026-09-24T03:01:00.000Z' });
    s.close();
    const r = new SqliteStateStore(path);
    expect(await r.findSessionByTokenHash('h'.repeat(64))).toMatchObject({ id: 'sess1234', ip: '1.2.3.4' });
    expect(await r.countSessionsByIpSince('1.2.3.4', '2026-09-24T00:00:00.000Z')).toBe(1);
    expect(await r.sessionImagesSince('sess1234', '2026-09-24T00:00:00.000Z')).toBe(3);
    expect(await r.costCentsSince('2026-09-24T00:00:00.000Z')).toBe(15);
    expect(await r.costCentsSince('2026-09-25T00:00:00.000Z')).toBe(0);
    expect((await r.entriesForSession('sess1234')).map((e) => e.status)).toEqual(['reserved', 'failed']);
    r.close();
  });

  it('filesystem content store is content-addressed and detects corruption', async () => {
    const cs = new FsContentStore(join(dir, 'blobs'));
    const data = new TextEncoder().encode('degent');
    const sha = await cs.put(data);
    expect(sha).toBe(sha256Hex(data));
    expect(await cs.put(data)).toBe(sha);
    expect(Buffer.from((await cs.get(sha))!).toString()).toBe('degent');
    expect(await cs.get('0'.repeat(64))).toBeNull();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'blobs', sha.slice(0, 2), sha), 'tampered');
    await expect(cs.get(sha)).rejects.toThrow(/corruption/);
  });
});
