/** Appeals (ADR-0012): an artist asks for a human look at a rejection; the house resolves it from its queue. */
import { describe, expect, it } from 'vitest';
import { api, makeHarness, signIn, submit, type Harness, type Session } from './fakes/harness.js';
import { FakeVisionReview, reject } from './fakes/misc.js';

const MSG = 'The bow tie is there: it is the dark shape under the collar, see the zoomed placard too.';

async function rejected(h: Harness, s: Session) {
  const sub = await submit(h, s);
  expect(sub.artwork.status).toBe('rejected');
  return sub.artworkId;
}

const appeal = (h: Harness, s: Session, id: string, message: unknown = MSG) => api(h, 'POST', `/v1/artworks/${id}/appeal`, { token: s.token, json: { message } });
const review = (h: Harness, id: string, decision: 'approve' | 'reject', reasons: string[] = []) =>
  api(h, 'POST', `/v1/artworks/${id}/review`, { apiKey: h.reviewerKey, json: { decision, reasons } });

describe('POST /v1/artworks/{id}/appeal', () => {
  it('moves a rejected artwork to reviewing with needsHuman, records the appeal and emits reviewing/appeal', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 2: no bow tie')) });
    const s = await signIn(h, 1);
    const id = await rejected(h, s);
    h.clock.advance(30);
    const r = await appeal(h, s, id);
    expect(r.status).toBe(201);
    expect(r.body.appeal).toEqual({
      id: `${id}:appeal:1`,
      artworkId: id,
      artist: s.address,
      message: MSG,
      status: 'open',
      createdAt: '2026-09-24T12:00:30.000Z',
      resolvedAt: null,
      resolution: null,
    });
    expect(r.body.artwork).toMatchObject({ status: 'reviewing', needsHuman: true, appeals: [r.body.appeal] });
    expect(r.body.artwork.timeline.at(-1)).toEqual({ status: 'reviewing', at: '2026-09-24T12:00:30.000Z', detail: 'appeal' });
    const ev = h.events.events.at(-1)!;
    expect(ev).toMatchObject({ type: 'degent.artwork.reviewing', status: 'reviewing', previousStatus: 'rejected', detail: 'appeal', eventId: `${id}:4` });
    expect(JSON.stringify(ev)).not.toContain('bow tie is there'); // the message never travels in events
    // it is in the house queue
    const q = await api(h, 'GET', '/v1/artworks?status=reviewing', { apiKey: h.reviewerKey });
    expect(q.body.items.map((a: { id: string }) => a.id)).toEqual([id]);
  });

  it('the house approving resolves the appeal as granted; rejecting resolves it as denied with the reasons', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 4: no placard')) });
    const s = await signIn(h, 2);
    const id = await rejected(h, s);
    await appeal(h, s, id);
    h.clock.advance(60);
    const denied = await review(h, id, 'reject', ['rule 4: the placard reads DEGNET']);
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ status: 'rejected', needsHuman: false });
    expect(denied.body.appeals[0]).toMatchObject({
      status: 'denied',
      resolvedAt: '2026-09-24T12:01:00.000Z',
      resolution: { decision: 'reject', reasons: ['rule 4: the placard reads DEGNET'], reviewerId: 'house-1', at: '2026-09-24T12:01:00.000Z' },
    });
    expect(denied.body.timeline.at(-1).detail).toBe('rejected by the house (appeal denied): rule 4: the placard reads DEGNET');
    // second appeal, granted
    await appeal(h, s, id, 'Fixed reading: DEGENT, look again please.');
    const granted = await review(h, id, 'approve');
    expect(granted.body.status).toBe('approved');
    expect(granted.body.appeals.map((a: { status: string }) => a.status)).toEqual(['denied', 'granted']);
    expect(granted.body.timeline.at(-1).detail).toBe('approved by the house (appeal granted)');
    expect((await api(h, 'GET', `/v1/artworks/${id}/content`)).status).toBe(200);
  });

  it('only rejected artworks: approved / reviewing / submitted / delisted are 409 illegal_transition', async () => {
    const h = makeHarness();
    const s = await signIn(h, 3);
    const sub = await submit(h, s); // approved
    const r = await appeal(h, s, sub.artworkId);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'illegal_transition', details: { status: 'approved', to: 'reviewing' } });
    await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    expect((await appeal(h, s, sub.artworkId)).body.error.code).toBe('illegal_transition');
    expect(h.events.events.filter((e) => e.detail === 'appeal')).toEqual([]);
  });

  it('one open appeal at a time and at most three per artwork (409 conflict)', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 1')) });
    const s = await signIn(h, 4);
    const id = await rejected(h, s);
    expect((await appeal(h, s, id)).status).toBe(201);
    const twice = await appeal(h, s, id);
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: 'conflict', details: { appeals: 1, max: 3 } });
    await review(h, id, 'reject', ['no']);
    expect((await appeal(h, s, id)).status).toBe(201);
    await review(h, id, 'reject', ['no']);
    expect((await appeal(h, s, id)).status).toBe(201);
    await review(h, id, 'reject', ['no']);
    const fourth = await appeal(h, s, id);
    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toMatchObject({ code: 'conflict', details: { appeals: 3, max: 3 } });
    expect(fourth.body.error.message).toMatch(/at most 3/);
  });

  it('a takedown (approved -> rejected by the house) can be appealed too', async () => {
    const h = makeHarness();
    const s = await signIn(h, 5);
    const sub = await submit(h, s);
    await review(h, sub.artworkId, 'reject', ['rule 3: not framed']);
    expect((await appeal(h, s, sub.artworkId)).body.artwork.status).toBe('reviewing');
  });

  it('only the artist; the message is validated', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 1')) });
    const s = await signIn(h, 6);
    const other = await signIn(h, 7);
    const id = await rejected(h, s);
    expect((await appeal(h, other, id)).status).toBe(403);
    expect((await api(h, 'POST', `/v1/artworks/${id}/appeal`, { json: { message: MSG } })).status).toBe(401);
    expect((await api(h, 'POST', `/v1/artworks/${id}/appeal`, { apiKey: h.reviewerKey, json: { message: MSG } })).status).toBe(401);
    expect((await appeal(h, s, 'art_nope')).status).toBe(404);
    expect((await api(h, 'POST', `/v1/artworks/${id}/appeal`, { token: s.token, json: {} })).status).toBe(422);
    for (const message of [null, '', '   ', 'x'.repeat(1001), 42, 'line\u0000break']) {
      const r = await appeal(h, s, id, message);
      expect(r.status, JSON.stringify(message)).toBe(422);
      expect(r.body.error.code).toBe('validation_failed');
    }
    expect((await api(h, 'POST', `/v1/artworks/${id}/appeal`, { token: s.token, json: { message: MSG, urgent: true } })).status).toBe(422);
    expect((await appeal(h, s, id, 'x'.repeat(1000))).status).toBe(201);
  });

  it('appeals are shown to the owner and API keys, never to the public', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 1')) });
    const s = await signIn(h, 8);
    const id = await rejected(h, s);
    await appeal(h, s, id);
    await review(h, id, 'approve');
    const pub = await api(h, 'GET', `/v1/artworks/${id}`);
    expect(pub.body.status).toBe('approved');
    expect(pub.body).not.toHaveProperty('appeals');
    expect((await api(h, 'GET', '/v1/artworks')).body.items[0]).not.toHaveProperty('appeals');
    expect((await api(h, 'GET', `/v1/artworks/${id}`, { token: s.token })).body.appeals).toHaveLength(1);
    expect((await api(h, 'GET', `/v1/artworks/${id}`, { apiKey: h.mintKey })).body.appeals).toHaveLength(1);
    expect((await api(h, 'GET', `/v1/artworks?artist=${s.address}`, { token: s.token })).body.items[0].appeals).toHaveLength(1);
  });
});

describe('GET /v1/appeals (the house queue)', () => {
  it('lists open appeals oldest first by default; granted / denied on request; pages', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 1')) });
    const a = await signIn(h, 9);
    const b = await signIn(h, 10);
    const ids: string[] = [];
    for (const s of [a, b, a]) {
      const id = await rejected(h, s);
      ids.push(id);
      h.clock.advance(10);
      await appeal(h, s, id);
    }
    await review(h, ids[1]!, 'approve');
    await review(h, ids[2]!, 'reject', ['still no bow tie']);
    const open = await api(h, 'GET', '/v1/appeals', { apiKey: h.reviewerKey });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ page: 1, pageSize: 24, total: 1 });
    expect(open.body.items.map((x: { artworkId: string }) => x.artworkId)).toEqual([ids[0]]);
    expect((await api(h, 'GET', '/v1/appeals?status=granted', { apiKey: h.reviewerKey })).body.items.map((x: { artworkId: string }) => x.artworkId)).toEqual([ids[1]]);
    const denied = await api(h, 'GET', '/v1/appeals?status=denied', { apiKey: h.reviewerKey });
    expect(denied.body.items[0]).toMatchObject({ artworkId: ids[2], status: 'denied', resolution: { reasons: ['still no bow tie'] } });
    // reopen two more and page through the open queue
    await appeal(h, a, ids[2]!);
    h.clock.advance(10);
    const p1 = await api(h, 'GET', '/v1/appeals?status=open&pageSize=1', { apiKey: h.reviewerKey });
    expect(p1.body).toMatchObject({ total: 2, pageSize: 1 });
    expect(p1.body.items[0].artworkId).toBe(ids[0]);
    const p2 = await api(h, 'GET', '/v1/appeals?status=open&pageSize=1&page=2', { apiKey: h.reviewerKey });
    expect(p2.body.items[0]).toMatchObject({ artworkId: ids[2], id: `${ids[2]}:appeal:2` });
  });

  it('needs scope studio:review; validates status and paging', async () => {
    const h = makeHarness();
    expect((await api(h, 'GET', '/v1/appeals')).body.error.code).toBe('missing_api_key');
    expect((await api(h, 'GET', '/v1/appeals', { apiKey: h.mintKey })).body.error.code).toBe('insufficient_scope');
    const s = await signIn(h, 11);
    expect((await api(h, 'GET', '/v1/appeals', { token: s.token })).status).toBe(401);
    expect((await api(h, 'GET', '/v1/appeals', { apiKey: h.bothKey })).status).toBe(200);
    for (const q of ['status=closed', 'page=0', 'pageSize=101']) {
      const r = await api(h, 'GET', `/v1/appeals?${q}`, { apiKey: h.reviewerKey });
      expect(r.status, q).toBe(422);
    }
  });
});
