/** Artwork lifecycle over HTTP: declaration, upload + one-shot review, house review, feature, delist, content endpoint. */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { api, declare, makeHarness, signIn, submit, upload, wallet } from './fakes/harness.js';
import { FakeVisionReview, needsHuman, reject } from './fakes/misc.js';
import { avif, jpeg, png, squareArt } from './fakes/images.js';

describe('POST /v1/artworks (declaration)', () => {
  it('creates a submitted artwork with a one-time upload token and emits the first event', async () => {
    const h = makeHarness();
    const s = await signIn(h, 1);
    const bytes = squareArt();
    const r = await api(h, 'POST', '/v1/artworks', { token: s.token, json: { title: ' Gentleman  No. 1 ', description: 'oil on chain', contentType: 'IMAGE/JPEG', contentLength: bytes.length } });
    expect(r.status).toBe(201);
    expect(r.body.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.artwork).toMatchObject({
      artist: s.address, network: 'regtest', title: 'Gentleman No. 1', description: 'oil on chain', contentType: 'image/jpeg', contentLength: bytes.length,
      contentSha256: null, status: 'submitted', needsHuman: false, review: null, featured: false, featuredAt: null, contentUrl: null,
    });
    expect(r.body.artwork.timeline).toHaveLength(1);
    expect(r.body.artwork.timeline[0].detail).toContain('Standard Degent');
    expect(r.body.artwork.timeline[0].detail).toContain('JPEG is the recommended format');
    expect(JSON.stringify(r.body)).not.toContain('uploadTokenHash');
    expect(h.events.events).toEqual([expect.objectContaining({ type: 'degent.artwork.submitted', artworkId: r.body.artwork.id, artist: s.address, previousStatus: null, eventId: `${r.body.artwork.id}:1` })]);
  });

  it('is unlimited per artist (rule: quantity)', async () => {
    const h = makeHarness();
    const s = await signIn(h, 2);
    for (let i = 0; i < 12; i++) await declare(h, s, { title: `#${i}` });
    expect((await api(h, 'GET', '/v1/artists/me', { token: s.token })).body.artworks.total).toBe(12);
  });

  it('validates title, description, content type and size against the rules', async () => {
    const h = makeHarness();
    const s = await signIn(h, 3);
    const base = { title: 'ok', contentType: 'image/jpeg', contentLength: 250_000 };
    const post = (json: unknown) => api(h, 'POST', '/v1/artworks', { token: s.token, json });
    expect((await post({ ...base, title: '' })).status).toBe(422);
    expect((await post({ ...base, title: 'x'.repeat(81) })).status).toBe(422);
    expect((await post({ ...base, title: 'x'.repeat(80) })).status).toBe(201);
    expect((await post({ ...base, description: 'x'.repeat(501) })).status).toBe(422);
    expect((await post({ ...base, description: 'x'.repeat(500) })).status).toBe(201);
    expect((await post({ ...base, contentLength: 199_999 })).status).toBe(422);
    expect((await post({ ...base, contentLength: 3_900_001 })).status).toBe(422);
    expect((await post({ ...base, contentLength: 3_900_000 })).status).toBe(201);
    expect((await post({ ...base, contentLength: 1.5 })).status).toBe(422);
    const svg = await post({ ...base, contentType: 'image/svg+xml' });
    expect(svg.status).toBe(422);
    expect(svg.body.error.details.checks.find((c: { id: string }) => c.id === 'content_type').passed).toBe(false);
    expect(svg.body.error.details.advice).toContain('image/jpeg (recommended)');
    expect((await post({ ...base, contentType: 'image/png' })).status).toBe(201);
    expect((await post({ title: 'x' })).status).toBe(422);
    expect((await post(null)).status).toBe(422);
    expect((await api(h, 'POST', '/v1/artworks', { json: base })).status).toBe(401);
  });
});

describe('PUT /v1/artworks/{id}/content (upload + review)', () => {
  it('approves a rule-compliant JPEG when the vision reviewer approves, in exactly two transitions', async () => {
    const h = makeHarness();
    const s = await signIn(h, 4);
    const sub = await declare(h, s);
    const a = await upload(h, sub);
    expect(a.status).toBe('approved');
    expect(a.contentSha256).toBe(sha256Hex(sub.bytes));
    expect(a.contentUrl).toBe(`/v1/artworks/${sub.artworkId}/content`);
    expect(a.needsHuman).toBe(false);
    expect(a.review!.automated).toMatchObject({ approved: true, needsHuman: false, reasons: [], reviewer: 'rules+vision' });
    expect(a.review!.automated!.checks.map((c) => c.id)).toEqual(['rules.magic_bytes', 'rules.dimensions_readable', 'rules.content_type', 'rules.size', 'rules.width', 'rules.height', 'rules.square', 'vision.guidelines']);
    expect(a.review!.house).toBeNull();
    expect(a.timeline.map((e) => e.status)).toEqual(['submitted', 'reviewing', 'approved']);
    expect(h.events.events.map((e) => [e.status, e.previousStatus])).toEqual([['submitted', null], ['reviewing', 'submitted'], ['approved', 'reviewing']]);
    expect(h.events.events[2]!.contentSha256).toBe(a.contentSha256);
    expect((h.vision as FakeVisionReview).calls).toHaveLength(1);
  });

  it('rejects when the rules fail (no vision call) and records the reasons', async () => {
    const h = makeHarness();
    const s = await signIn(h, 5);
    const sub = await declare(h, s, { bytes: jpeg(1024, 768, 250_000) });
    const a = await upload(h, sub);
    expect(a.status).toBe('rejected');
    expect(a.review!.automated!.reasons).toEqual(['not square (1024x768px); width must equal height']);
    expect(a.timeline[a.timeline.length - 1]!.detail).toContain('not square');
    expect((h.vision as FakeVisionReview).calls).toHaveLength(0);
    const mismatch = await declare(h, s, { bytes: png(1024, 1024, 250_000), contentType: 'image/jpeg' });
    expect((await upload(h, mismatch)).review!.automated!.checks.find((c) => c.id === 'rules.magic_bytes')!.passed).toBe(false);
  });

  it('rejects when the vision reviewer rejects, keeping its reasons', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 2: no bow tie', 'rule 4: placard reads DEGNET')) });
    const s = await signIn(h, 6);
    const a = await upload(h, await declare(h, s));
    expect(a.status).toBe('rejected');
    expect(a.review!.automated!.reasons).toEqual(['rule 2: no bow tie', 'rule 4: placard reads DEGNET']);
    expect(h.events.events.map((e) => e.status)).toEqual(['submitted', 'reviewing', 'rejected']);
  });

  it('NEVER approves on a skipped vision check: stays reviewing with needsHuman', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman('vision review skipped: too big')) });
    const s = await signIn(h, 7);
    const a = await upload(h, await declare(h, s));
    expect(a.status).toBe('reviewing');
    expect(a.needsHuman).toBe(true);
    expect(a.contentUrl).toBeNull();
    expect(a.review!.automated).toMatchObject({ approved: false, needsHuman: true, reasons: [] });
    expect(a.timeline[a.timeline.length - 1]!.detail).toContain('waiting for a house reviewer');
    expect(h.events.events.map((e) => e.status)).toEqual(['submitted', 'reviewing']);
    expect((await api(h, 'GET', `/v1/artworks/${a.id}/content`)).status).toBe(404);
  });

  it('503 review_unavailable when the reviewer throws; the artwork stays submitted for a retry', async () => {
    const vision = new FakeVisionReview(new Error('boom'));
    const h = makeHarness({ vision });
    const s = await signIn(h, 8);
    const sub = await declare(h, s);
    const r = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes, token: sub.uploadToken });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('review_unavailable');
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { token: s.token })).body.status).toBe('submitted');
    vision.result = { approved: true, needsHuman: false, reasons: [], checks: [] };
    expect((await upload(h, sub)).status).toBe('approved');
  });

  it('checks the upload token before reading the body, and the content type', async () => {
    const h = makeHarness();
    const s = await signIn(h, 9);
    const sub = await declare(h, s);
    const other = await declare(h, s);
    expect((await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes })).status).toBe(401);
    expect((await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes, token: s.token })).status).toBe(401);
    const wrong = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes, token: other.uploadToken });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('forbidden');
    const badType = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes, token: sub.uploadToken, headers: { 'content-type': 'image/jpeg' } });
    expect(badType.status).toBe(415);
    expect((await api(h, 'PUT', '/v1/artworks/nope/content', { bytes: sub.bytes, token: sub.uploadToken })).status).toBe(404);
    expect((await api(h, 'PUT', '/v1/artworks/bad id!/content', { bytes: sub.bytes, token: sub.uploadToken })).status).toBe(404);
  });

  it('422 content_mismatch when the length differs; 409 once content exists; 413 above the limit', async () => {
    const h = makeHarness();
    const s = await signIn(h, 10);
    const sub = await declare(h, s);
    const short = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes.slice(0, 1000), token: sub.uploadToken });
    expect(short.status).toBe(422);
    expect(short.body.error).toMatchObject({ code: 'content_mismatch', details: { declared: sub.bytes.length, received: 1000 } });
    await upload(h, sub);
    const again = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes, token: sub.uploadToken });
    expect(again.status).toBe(409);
    expect(again.body.error.details.status).toBe('approved');
    const big = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes, token: sub.uploadToken, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } });
    expect(big.status).toBe(413);
  });

  it('accepts every allowed format (PNG, AVIF) when square and within bounds', async () => {
    const h = makeHarness();
    const s = await signIn(h, 11);
    const p = await upload(h, await declare(h, s, { bytes: png(2048, 2048, 500_000), contentType: 'image/png' }));
    expect(p.status).toBe('approved');
    const a = await upload(h, await declare(h, s, { bytes: avif(4096, 4096, 3_600_000), contentType: 'image/avif' }));
    expect(a.status).toBe('approved');
    expect(a.timeline[0]!.detail).toContain('Full Block Degent');
  });
});

describe('GET /v1/artworks/{id} visibility', () => {
  it('approved artworks are public; others only for the owner or an API key', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman()) });
    const s = await signIn(h, 12);
    const stranger = await signIn(h, 13);
    const sub = await declare(h, s);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).status).toBe(404);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { token: stranger.token })).status).toBe(404);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { token: s.token })).status).toBe(200);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { apiKey: h.reviewerKey })).status).toBe(200);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { apiKey: h.mintKey })).status).toBe(200);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { apiKey: 'bsh_test_nope' })).status).toBe(401);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { token: 'a.b.c' })).status).toBe(401);
    await upload(h, sub);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).status).toBe(404); // reviewing (needsHuman)
    await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).status).toBe(200);
    expect((await api(h, 'GET', '/v1/artworks/unknown')).status).toBe(404);
  });
});

describe('POST /v1/artworks/{id}/review (house reviewer)', () => {
  it('resolves needsHuman: approve', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman()) });
    const s = await signIn(h, 14);
    const sub = await submit(h, s);
    expect(sub.artwork.status).toBe('reviewing');
    const r = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'approved', needsHuman: false, contentUrl: `/v1/artworks/${sub.artworkId}/content` });
    expect(r.body.review.house).toEqual({ decision: 'approve', reasons: [], reviewerId: 'house-1', at: '2026-09-24T12:00:00.000Z' });
    expect(r.body.review.automated.needsHuman).toBe(true); // history kept
    expect(h.events.events[h.events.events.length - 1]).toMatchObject({ status: 'approved', previousStatus: 'reviewing', detail: 'approved by the house' });
  });

  it('resolves needsHuman: reject with reasons shown to the artist', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman()) });
    const s = await signIn(h, 15);
    const sub = await submit(h, s);
    const r = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'reject', reasons: ['rule 3: not framed', ' rule 4: no placard '] } });
    expect(r.body.status).toBe('rejected');
    expect(r.body.review.house.reasons).toEqual(['rule 3: not framed', 'rule 4: no placard']);
    expect(r.body.timeline[r.body.timeline.length - 1].detail).toBe('rejected by the house: rule 3: not framed; rule 4: no placard');
    const mine = await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    expect(mine.body.review.house.reasons).toHaveLength(2);
  });

  it('can take down an approved artwork and reinstate a rejected one, but not touch submitted or delisted ones', async () => {
    const h = makeHarness();
    const s = await signIn(h, 16);
    const sub = await submit(h, s);
    const down = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'reject', reasons: ['reported'] } });
    expect(down.body.status).toBe('rejected');
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}/content`)).status).toBe(404);
    const up = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    expect(up.body.status).toBe('approved');
    const twice = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: 'illegal_transition', details: { status: 'approved', to: 'approved' } });
    const fresh = await declare(h, s);
    expect((await api(h, 'POST', `/v1/artworks/${fresh.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } })).status).toBe(409);
    await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    expect((await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } })).status).toBe(409);
  });

  it('requires the studio:review scope and validates the body', async () => {
    const h = makeHarness();
    const s = await signIn(h, 17);
    const sub = await submit(h, s);
    const path = `/v1/artworks/${sub.artworkId}/review`;
    expect((await api(h, 'POST', path, { json: { decision: 'reject' } })).body.error.code).toBe('missing_api_key');
    expect((await api(h, 'POST', path, { token: s.token, json: { decision: 'reject' } })).body.error.code).toBe('missing_api_key');
    expect((await api(h, 'POST', path, { apiKey: h.mintKey, json: { decision: 'reject' } })).body.error.code).toBe('insufficient_scope');
    expect((await api(h, 'POST', path, { apiKey: h.bothKey, json: { decision: 'nope' } })).status).toBe(422);
    expect((await api(h, 'POST', path, { apiKey: h.bothKey, json: { decision: 'reject', reasons: 'x' } })).status).toBe(422);
    expect((await api(h, 'POST', path, { apiKey: h.bothKey, json: { decision: 'reject', reasons: new Array(11).fill('x') } })).status).toBe(422);
    expect((await api(h, 'POST', path, { apiKey: h.bothKey, json: { decision: 'reject', reasons: ['x'.repeat(201)] } })).status).toBe(422);
    expect((await api(h, 'POST', '/v1/artworks/unknown/review', { apiKey: h.bothKey, json: { decision: 'reject' } })).status).toBe(404);
    // Bearer bsh_ keys work too.
    expect((await api(h, 'POST', path, { token: h.bothKey, json: { decision: 'reject', reasons: ['x'] } })).status).toBe(200);
  });
});

describe('POST /v1/artworks/{id}/feature', () => {
  it('flags approved artworks only, keeps the first featuredAt, and is not a status transition', async () => {
    const h = makeHarness();
    const s = await signIn(h, 18);
    const sub = await submit(h, s);
    const before = h.events.events.length;
    const on = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/feature`, { apiKey: h.reviewerKey, json: { featured: true } });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ featured: true, featuredAt: '2026-09-24T12:00:00.000Z', status: 'approved' });
    h.clock.advance(60);
    const again = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/feature`, { apiKey: h.reviewerKey, json: { featured: true } });
    expect(again.body.featuredAt).toBe('2026-09-24T12:00:00.000Z');
    const off = await api(h, 'POST', `/v1/artworks/${sub.artworkId}/feature`, { apiKey: h.reviewerKey, json: { featured: false } });
    expect(off.body).toMatchObject({ featured: false, featuredAt: null });
    expect(h.events.events.length).toBe(before);
    expect((await api(h, 'POST', `/v1/artworks/${sub.artworkId}/feature`, { apiKey: h.reviewerKey, json: { featured: 'yes' } })).status).toBe(422);
    expect((await api(h, 'POST', `/v1/artworks/${sub.artworkId}/feature`, { apiKey: h.mintKey, json: { featured: true } })).status).toBe(403);
    const pending = await declare(h, s);
    const r = await api(h, 'POST', `/v1/artworks/${pending.artworkId}/feature`, { apiKey: h.reviewerKey, json: { featured: true } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('conflict');
  });
});

describe('DELETE /v1/artworks/{id} (artist delists)', () => {
  it('approved -> delisted by the owner only; content disappears; anything else is 409', async () => {
    const h = makeHarness();
    const s = await signIn(h, 19);
    const other = await signIn(h, 20);
    const sub = await submit(h, s);
    expect((await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`)).status).toBe(401);
    const notMine = await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: other.token });
    expect(notMine.status).toBe(403);
    const r = await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'delisted', contentUrl: null, contentSha256: sha256Hex(sub.bytes) });
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}/content`)).status).toBe(404);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).status).toBe(404);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`, { token: s.token })).body.status).toBe('delisted');
    expect((await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token })).status).toBe(409);
    const pending = await declare(h, s);
    expect((await api(h, 'DELETE', `/v1/artworks/${pending.artworkId}`, { token: s.token })).body.error.code).toBe('illegal_transition');
    expect((await api(h, 'DELETE', '/v1/artworks/unknown', { token: s.token })).status).toBe(404);
    expect(h.events.events.find((e) => e.status === 'delisted')).toMatchObject({ artworkId: sub.artworkId, previousStatus: 'approved', detail: 'delisted by the artist' });
    expect((await api(h, 'GET', '/v1/artists/me', { token: s.token })).body.artworks).toEqual({ total: 2, approved: 0 });
  });
});

describe('GET /v1/artworks/{id}/content', () => {
  it('serves the exact bytes with the real content type, immutable caching and ETag = sha256', async () => {
    const h = makeHarness();
    const s = await signIn(h, 21);
    const sub = await submit(h, s, { bytes: png(512, 512, 300_000), contentType: 'image/png' });
    const r = await api(h, 'GET', `/v1/artworks/${sub.artworkId}/content`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-length')).toBe(String(sub.bytes.length));
    expect(r.headers.get('etag')).toBe(`"${sha256Hex(sub.bytes)}"`);
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(r.raw).equals(Buffer.from(sub.bytes))).toBe(true);
    expect(sha256Hex(r.raw)).toBe(sub.artwork.contentSha256);
  });

  it('answers 304 to a matching If-None-Match (strong, weak, list, *)', async () => {
    const h = makeHarness();
    const s = await signIn(h, 22);
    const sub = await submit(h, s);
    const etag = `"${sha256Hex(sub.bytes)}"`;
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const r = await api(h, 'GET', `/v1/artworks/${sub.artworkId}/content`, { headers: { 'if-none-match': inm } });
      expect(r.status, inm).toBe(304);
      expect(r.headers.get('etag')).toBe(etag);
      expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(r.raw.length).toBe(0);
    }
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}/content`, { headers: { 'if-none-match': '"nope"' } })).status).toBe(200);
  });

  it('is 404 for anything not approved (submitted, reviewing, rejected, delisted) and unknown ids', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman()) });
    const s = await signIn(h, 23);
    const sub = await declare(h, s);
    const get = () => api(h, 'GET', `/v1/artworks/${sub.artworkId}/content`, { token: s.token });
    expect((await get()).status).toBe(404);
    await upload(h, sub);
    expect((await get()).status).toBe(404);
    await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'reject', reasons: ['x'] } });
    expect((await get()).status).toBe(404);
    await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    expect((await get()).status).toBe(200);
    await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    expect((await get()).status).toBe(404);
    expect((await api(h, 'GET', '/v1/artworks/nope/content')).status).toBe(404);
    expect((await api(h, 'GET', '/v1/artworks/nope/content')).body.error.code).toBe('not_found');
  });

  it('two artists uploading identical bytes share one blob and both serve it', async () => {
    const h = makeHarness();
    const a = await signIn(h, 24);
    const b = await signIn(h, 25);
    const bytes = squareArt();
    const x = await submit(h, a, { bytes });
    const y = await submit(h, b, { bytes });
    expect(x.artwork.contentSha256).toBe(y.artwork.contentSha256);
    expect((await api(h, 'GET', `/v1/artworks/${x.artworkId}/content`)).status).toBe(200);
    await api(h, 'DELETE', `/v1/artworks/${x.artworkId}`, { token: a.token });
    expect((await api(h, 'GET', `/v1/artworks/${y.artworkId}/content`)).status).toBe(200);
  });
});

describe('edge behaviour', () => {
  it('rate limits mutating requests per IP but never reads', async () => {
    const h = makeHarness({ rateLimitPerMinute: 2 });
    const w = wallet(26);
    const body = { json: { address: w.address, network: 'regtest' } };
    expect((await api(h, 'POST', '/v1/auth/challenge', { ...body, ip: '203.0.113.1' })).status).toBe(201);
    expect((await api(h, 'POST', '/v1/auth/challenge', { ...body, ip: '203.0.113.1' })).status).toBe(201);
    const limited = await api(h, 'POST', '/v1/auth/challenge', { ...body, ip: '203.0.113.1' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await api(h, 'POST', '/v1/auth/challenge', { ...body, ip: '203.0.113.2' })).status).toBe(201);
    for (let i = 0; i < 5; i++) expect((await api(h, 'GET', '/v1/config', { ip: '203.0.113.1' })).status).toBe(200);
  });

  it('CORS: allowlisted origin gets headers, others get none and preflight 403', async () => {
    const h = makeHarness();
    const ok = await api(h, 'GET', '/v1/config', { headers: { origin: 'https://degent.club' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://degent.club');
    const no = await api(h, 'GET', '/v1/config', { headers: { origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await api(h, 'OPTIONS', '/v1/artworks', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(403);
    const preOk = await api(h, 'OPTIONS', '/v1/artworks', { headers: { origin: 'https://degent.club', 'access-control-request-method': 'PUT' } });
    expect(preOk.status).toBe(204);
    expect(preOk.headers.get('access-control-allow-headers')).toContain('X-API-Key');
  });

  it('every response carries a request id and security headers; JSON is no-store', async () => {
    const h = makeHarness();
    const r = await api(h, 'GET', '/v1/health');
    expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({ status: 'ok', network: 'regtest', checks: { store: { ok: true }, review: { ok: true, detail: 'rules+vision' } } });
    const cfg = await api(h, 'GET', '/v1/config');
    expect(cfg.body.rules.map((x: { id: string }) => x.id)).toEqual(['format', 'square', 'design', 'framing', 'quantity']);
    expect(cfg.body).toMatchObject({ rulesVersion: '1.0.0', recommendedContentType: 'image/jpeg', payoutMessageTemplate: 'degent.club payout address <address> for <sessionSub>', visionReview: 'claude', titleMaxChars: 80, descriptionMaxChars: 500, displayNameMaxChars: 40 });
  });

  it('JSON bodies above 16 KiB are 413', async () => {
    const h = makeHarness();
    const s = await signIn(h, 27);
    const r = await api(h, 'POST', '/v1/artworks', { token: s.token, json: { title: 'x', description: 'y', contentType: 'image/jpeg', contentLength: 250_000, pad: 'z'.repeat(17_000) } });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('payload_too_large');
  });
});
