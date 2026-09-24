/** Royalty records posted by the mint service and the artist's view with totals. */
import { describe, expect, it } from 'vitest';
import { api, makeHarness, signIn, submit, wallet } from './fakes/harness.js';

const record = (artworkId: string, i: number, sats = 10_000) => ({
  orderId: `dgt_${i}`,
  artworkId,
  minterAddress: wallet(500 + i).address,
  royaltySats: sats,
  fundingTxid: (i % 10).toString().repeat(64),
  vout: 1,
  at: new Date(Date.UTC(2026, 8, 24, 13, i)).toISOString(),
});

describe('POST /v1/internal/royalties', () => {
  it('records a royalty for an artwork and attributes it to its artist', async () => {
    const h = makeHarness();
    const s = await signIn(h, 1);
    const sub = await submit(h, s);
    const r = await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: record(sub.artworkId, 1) });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.record).toMatchObject({ orderId: 'dgt_1', artworkId: sub.artworkId, artist: s.address, royaltySats: 10_000, vout: 1, recordedAt: '2026-09-24T12:00:00.000Z' });
  });

  it('is idempotent on orderId: same facts 200, different facts 409', async () => {
    const h = makeHarness();
    const s = await signIn(h, 2);
    const sub = await submit(h, s);
    const rec = record(sub.artworkId, 2);
    expect((await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: rec })).status).toBe(201);
    const again = await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: { ...rec, minterAddress: null } });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    const diff = await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: { ...rec, royaltySats: 1 } });
    expect(diff.status).toBe(409);
    expect(diff.body.error.details.existing.royaltySats).toBe(10_000);
    expect((await api(h, 'GET', '/v1/artists/me/royalties', { token: s.token })).body.totals).toEqual({ records: 1, royaltySats: 10_000 });
  });

  it('requires the studio:internal scope', async () => {
    const h = makeHarness();
    const s = await signIn(h, 3);
    const sub = await submit(h, s);
    const rec = record(sub.artworkId, 3);
    expect((await api(h, 'POST', '/v1/internal/royalties', { json: rec })).body.error.code).toBe('missing_api_key');
    expect((await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.reviewerKey, json: rec })).body.error.code).toBe('insufficient_scope');
    expect((await api(h, 'POST', '/v1/internal/royalties', { apiKey: 'bsh_live_' + '1'.repeat(44), json: rec })).body.error.code).toBe('invalid_api_key');
    expect((await api(h, 'POST', '/v1/internal/royalties', { token: s.token, json: rec })).body.error.code).toBe('missing_api_key');
    expect((await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.bothKey, json: rec })).status).toBe(201);
  });

  it('validates every field and refuses unknown artworks', async () => {
    const h = makeHarness();
    const s = await signIn(h, 4);
    const sub = await submit(h, s);
    const ok = record(sub.artworkId, 4);
    const post = (json: unknown) => api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json });
    const bad: Array<[string, unknown]> = [
      ['orderId', { ...ok, orderId: 'bad id!' }],
      ['artworkId', { ...ok, artworkId: '' }],
      ['royaltySats negative', { ...ok, royaltySats: -1 }],
      ['royaltySats float', { ...ok, royaltySats: 1.5 }],
      ['fundingTxid', { ...ok, fundingTxid: 'xyz' }],
      ['vout', { ...ok, vout: -1 }],
      ['at', { ...ok, at: 'yesterday' }],
      ['minterAddress type', { ...ok, minterAddress: 5 }],
      ['not an object', []],
    ];
    for (const [name, json] of bad) {
      const r = await post(json);
      expect(r.status, name).toBe(422);
      expect(r.body.error.code, name).toBe('validation_failed');
    }
    const unknown = await post({ ...ok, artworkId: 'art_unknown' });
    expect(unknown.status).toBe(404);
    const upper = await post({ ...ok, fundingTxid: 'AB'.repeat(32) });
    expect(upper.status).toBe(201);
    expect(upper.body.record.fundingTxid).toBe('ab'.repeat(32));
  });

  it('accepts royalties for non-approved artworks too (a mint that started before a takedown)', async () => {
    const h = makeHarness();
    const s = await signIn(h, 5);
    const sub = await submit(h, s);
    await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    expect((await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: record(sub.artworkId, 5) })).status).toBe(201);
  });
});

describe('GET /v1/artists/me/royalties', () => {
  it('lists newest first with totals over all records and pages', async () => {
    const h = makeHarness();
    const s = await signIn(h, 6);
    const other = await signIn(h, 7);
    const a = await submit(h, s);
    const b = await submit(h, s);
    const o = await submit(h, other);
    for (let i = 0; i < 5; i++) await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: record(i % 2 ? a.artworkId : b.artworkId, i, 1_000 * (i + 1)) });
    await api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: record(o.artworkId, 9, 99_999) });
    const r = await api(h, 'GET', '/v1/artists/me/royalties', { token: s.token });
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: { orderId: string }) => x.orderId)).toEqual(['dgt_4', 'dgt_3', 'dgt_2', 'dgt_1', 'dgt_0']);
    expect(r.body.totals).toEqual({ records: 5, royaltySats: 15_000 });
    expect(r.body).toMatchObject({ page: 1, pageSize: 24, total: 5 });
    const p2 = await api(h, 'GET', '/v1/artists/me/royalties?page=2&pageSize=2', { token: s.token });
    expect(p2.body.items.map((x: { orderId: string }) => x.orderId)).toEqual(['dgt_2', 'dgt_1']);
    expect(p2.body.totals.royaltySats).toBe(15_000);
    const theirs = await api(h, 'GET', '/v1/artists/me/royalties', { token: other.token });
    expect(theirs.body.totals).toEqual({ records: 1, royaltySats: 99_999 });
    expect((await api(h, 'GET', '/v1/artists/me/royalties?page=0', { token: s.token })).status).toBe(422);
    expect((await api(h, 'GET', '/v1/artists/me/royalties')).status).toBe(401);
  });

  it('an artist with no mints sees zero totals', async () => {
    const h = makeHarness();
    const s = await signIn(h, 8);
    const r = await api(h, 'GET', '/v1/artists/me/royalties', { token: s.token });
    expect(r.body).toEqual({ items: [], totals: { records: 0, royaltySats: 0 }, page: 1, pageSize: 24, total: 0 });
  });
});
