/** Gallery listing: featured first then newest, paging, filters, visibility of non-approved statuses. */
import { describe, expect, it } from 'vitest';
import { api, declare, makeHarness, signIn, submit, type Harness, type Session } from './fakes/harness.js';
import { FakeVisionReview, needsHuman } from './fakes/misc.js';
import { jpeg } from './fakes/images.js';

async function seed(h: Harness, s: Session, n: number, seedFrom = 100) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sub = await submit(h, s, { title: `#${i}`, bytes: jpeg(1024, 1024, 210_000, seedFrom + i) });
    ids.push(sub.artworkId);
    h.clock.advance(60);
  }
  return ids;
}

describe('GET /v1/artworks (gallery)', () => {
  it('lists approved artworks newest first, with featured ones on top', async () => {
    const h = makeHarness();
    const s = await signIn(h, 1);
    const ids = await seed(h, s, 5);
    await api(h, 'POST', `/v1/artworks/${ids[1]}/feature`, { apiKey: h.reviewerKey, json: { featured: true } });
    await api(h, 'POST', `/v1/artworks/${ids[3]}/feature`, { apiKey: h.reviewerKey, json: { featured: true } });
    const r = await api(h, 'GET', '/v1/artworks');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
    expect(r.body.items.map((a: { id: string }) => a.id)).toEqual([ids[3], ids[1], ids[4], ids[2], ids[0]]);
    expect(r.body.items.every((a: { status: string; contentUrl: string | null }) => a.status === 'approved' && a.contentUrl)).toBe(true);
  });

  it('pages with page / pageSize and reports total', async () => {
    const h = makeHarness();
    const s = await signIn(h, 2);
    const ids = await seed(h, s, 7);
    const p1 = await api(h, 'GET', '/v1/artworks?pageSize=3');
    expect(p1.body).toMatchObject({ page: 1, pageSize: 3, total: 7 });
    expect(p1.body.items.map((a: { id: string }) => a.id)).toEqual([ids[6], ids[5], ids[4]]);
    const p2 = await api(h, 'GET', '/v1/artworks?pageSize=3&page=2');
    expect(p2.body.items.map((a: { id: string }) => a.id)).toEqual([ids[3], ids[2], ids[1]]);
    const p3 = await api(h, 'GET', '/v1/artworks?pageSize=3&page=3');
    expect(p3.body.items.map((a: { id: string }) => a.id)).toEqual([ids[0]]);
    expect((await api(h, 'GET', '/v1/artworks?pageSize=3&page=4')).body.items).toEqual([]);
    const dflt = await api(h, 'GET', '/v1/artworks');
    expect(dflt.body.pageSize).toBe(24);
  });

  it('validates paging parameters', async () => {
    const h = makeHarness();
    for (const q of ['page=0', 'page=x', 'pageSize=0', 'pageSize=101', 'pageSize=1.5', 'status=weird']) {
      const r = await api(h, 'GET', `/v1/artworks?${q}`);
      expect(r.status, q).toBe(422);
      expect(r.body.error.code).toBe('validation_failed');
    }
    expect((await api(h, 'GET', '/v1/artworks?pageSize=100&page=1')).status).toBe(200);
  });

  it('filters by artist and excludes delisted / rejected pieces from the public gallery', async () => {
    const h = makeHarness();
    const a = await signIn(h, 3);
    const b = await signIn(h, 4);
    const ia = await seed(h, a, 2);
    const ib = await seed(h, b, 3, 200);
    await api(h, 'DELETE', `/v1/artworks/${ib[0]}`, { token: b.token });
    await api(h, 'POST', `/v1/artworks/${ib[1]}/review`, { apiKey: h.reviewerKey, json: { decision: 'reject', reasons: ['x'] } });
    const all = await api(h, 'GET', '/v1/artworks');
    expect(all.body.items.map((x: { id: string }) => x.id).sort()).toEqual([...ia, ib[2]].sort());
    const onlyB = await api(h, 'GET', `/v1/artworks?artist=${b.address}`);
    expect(onlyB.body.items.map((x: { id: string }) => x.id)).toEqual([ib[2]]);
    expect((await api(h, 'GET', `/v1/artworks?artist=${a.address}`)).body.total).toBe(2);
    expect((await api(h, 'GET', '/v1/artworks?artist=nobody')).body.total).toBe(0);
  });

  it('non-approved statuses: anonymous 401, other artists 403, own submissions and API keys ok', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman()) });
    const a = await signIn(h, 5);
    const b = await signIn(h, 6);
    const subA = await submit(h, a); // reviewing
    await declare(h, a); // submitted
    await submit(h, b);
    expect((await api(h, 'GET', '/v1/artworks?status=reviewing')).status).toBe(401);
    expect((await api(h, 'GET', `/v1/artworks?status=reviewing&artist=${b.address}`, { token: a.token })).status).toBe(403);
    expect((await api(h, 'GET', '/v1/artworks?status=reviewing', { token: a.token })).status).toBe(403);
    const mine = await api(h, 'GET', `/v1/artworks?status=reviewing&artist=${a.address}`, { token: a.token });
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual([subA.artworkId]);
    const subs = await api(h, 'GET', `/v1/artworks?status=submitted&artist=${a.address}`, { token: a.token });
    expect(subs.body.total).toBe(1);
    const queue = await api(h, 'GET', '/v1/artworks?status=reviewing', { apiKey: h.reviewerKey });
    expect(queue.status).toBe(200);
    expect(queue.body.total).toBe(2);
    expect(queue.body.items.every((x: { needsHuman: boolean }) => x.needsHuman)).toBe(true);
    expect((await api(h, 'GET', '/v1/artworks?status=reviewing', { apiKey: h.mintKey })).status).toBe(200);
    expect((await api(h, 'GET', '/v1/artworks?status=approved')).body.total).toBe(0);
  });

  it('a delisted artwork loses its featured spot in the gallery', async () => {
    const h = makeHarness();
    const s = await signIn(h, 7);
    const ids = await seed(h, s, 3);
    await api(h, 'POST', `/v1/artworks/${ids[0]}/feature`, { apiKey: h.reviewerKey, json: { featured: true } });
    expect((await api(h, 'GET', '/v1/artworks')).body.items[0].id).toBe(ids[0]);
    await api(h, 'DELETE', `/v1/artworks/${ids[0]}`, { token: s.token });
    const r = await api(h, 'GET', '/v1/artworks');
    expect(r.body.items.map((x: { id: string }) => x.id)).toEqual([ids[2], ids[1]]);
  });
});
