/** Edition caps (ADR-0012): maxEditions at declaration and later, mintedEditions from royalty records, soldOut, ?available. */
import { describe, expect, it } from 'vitest';
import { api, declare, makeHarness, signIn, submit, wallet, type Harness } from './fakes/harness.js';
import { jpeg } from './fakes/images.js';

const royalty = (artworkId: string, i: number, extra: Record<string, unknown> = {}) => ({
  orderId: `dgt_${artworkId}_${i}`,
  artworkId,
  minterAddress: wallet(700 + i).address,
  royaltySats: 5_000,
  fundingTxid: (i % 10).toString().repeat(64),
  vout: 1,
  at: new Date(Date.UTC(2026, 8, 24, 13, i)).toISOString(),
  ...extra,
});

const mint = (h: Harness, artworkId: string, i: number, extra: Record<string, unknown> = {}) =>
  api(h, 'POST', '/v1/internal/royalties', { apiKey: h.mintKey, json: royalty(artworkId, i, extra) });

const setCap = (h: Harness, token: string, id: string, maxEditions: unknown) => api(h, 'PUT', `/v1/artworks/${id}/editions`, { token, json: { maxEditions } });

describe('maxEditions at declaration', () => {
  it('defaults to an open edition; a cap in 1..10000 is kept; the view carries mintedEditions and soldOut', async () => {
    const h = makeHarness();
    const s = await signIn(h, 1);
    const open = await declare(h, s);
    expect(open.artwork).toMatchObject({ maxEditions: null, mintedEditions: 0, soldOut: false, featuredRank: null, appeals: [] });
    const capped = await api(h, 'POST', '/v1/artworks', { token: s.token, json: { title: 'Ten', contentType: 'image/jpeg', contentLength: 250_000, maxEditions: 10 } });
    expect(capped.status).toBe(201);
    expect(capped.body.artwork).toMatchObject({ maxEditions: 10, mintedEditions: 0, soldOut: false });
    const nul = await api(h, 'POST', '/v1/artworks', { token: s.token, json: { title: 'Open', contentType: 'image/jpeg', contentLength: 250_000, maxEditions: null } });
    expect(nul.body.artwork.maxEditions).toBeNull();
  });

  it.each([0, -1, 10_001, 2.5, '5', true])('refuses maxEditions %j with 422 validation_failed', async (v) => {
    const h = makeHarness();
    const s = await signIn(h, 2);
    const r = await api(h, 'POST', '/v1/artworks', { token: s.token, json: { title: 'x', contentType: 'image/jpeg', contentLength: 250_000, maxEditions: v } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('validation_failed');
    expect(r.body.error.message).toMatch(/maxEditions/);
  });
});

describe('PUT /v1/artworks/{id}/editions', () => {
  it('before the first mint any cap (or none) is accepted, in any live status', async () => {
    const h = makeHarness();
    const s = await signIn(h, 3);
    const sub = await declare(h, s); // submitted
    let r = await setCap(h, s.token, sub.artworkId, 1);
    expect(r.status).toBe(200);
    expect(r.body.maxEditions).toBe(1);
    r = await setCap(h, s.token, sub.artworkId, 10_000);
    expect(r.body.maxEditions).toBe(10_000);
    r = await setCap(h, s.token, sub.artworkId, null);
    expect(r.body.maxEditions).toBeNull();
    const approved = await submit(h, s, { bytes: jpeg(1024, 1024, 210_000, 31) });
    expect((await setCap(h, s.token, approved.artworkId, 3)).body).toMatchObject({ status: 'approved', maxEditions: 3, soldOut: false });
  });

  it('after mints: raising and opening are allowed, lowering only down to mintedEditions (409 below it)', async () => {
    const h = makeHarness();
    const s = await signIn(h, 4);
    const sub = await submit(h, s);
    await setCap(h, s.token, sub.artworkId, 5);
    for (let i = 0; i < 3; i++) expect((await mint(h, sub.artworkId, i)).status).toBe(201);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).body).toMatchObject({ maxEditions: 5, mintedEditions: 3, soldOut: false });
    const low = await setCap(h, s.token, sub.artworkId, 2);
    expect(low.status).toBe(409);
    expect(low.body.error).toMatchObject({ code: 'conflict', details: { mintedEditions: 3, maxEditions: 2 } });
    expect((await setCap(h, s.token, sub.artworkId, 3)).body).toMatchObject({ maxEditions: 3, soldOut: true });
    expect((await setCap(h, s.token, sub.artworkId, 20)).body).toMatchObject({ maxEditions: 20, soldOut: false });
    expect((await setCap(h, s.token, sub.artworkId, null)).body).toMatchObject({ maxEditions: null, soldOut: false });
  });

  it('only the artist, never on a delisted artwork, and the body is validated', async () => {
    const h = makeHarness();
    const s = await signIn(h, 5);
    const other = await signIn(h, 6);
    const sub = await submit(h, s);
    expect((await setCap(h, other.token, sub.artworkId, 3)).status).toBe(403);
    expect((await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/editions`, { json: { maxEditions: 3 } })).status).toBe(401);
    expect((await setCap(h, s.token, 'art_nope', 3)).status).toBe(404);
    for (const json of [{}, { maxEditions: 0 }, { maxEditions: 'ten' }, { maxEditions: 3, extra: 1 }, []]) {
      const r = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/editions`, { token: s.token, json });
      expect(r.status, JSON.stringify(json)).toBe(422);
    }
    await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    const r = await setCap(h, s.token, sub.artworkId, 3);
    expect(r.status).toBe(409);
    expect(r.body.error.details).toEqual({ status: 'delisted' });
  });
});

describe('mintedEditions and soldOut from royalty records', () => {
  it('each NEW record counts one edition; a replay does not; the cap flips soldOut', async () => {
    const h = makeHarness();
    const s = await signIn(h, 7);
    const sub = await submit(h, s);
    await setCap(h, s.token, sub.artworkId, 2);
    expect((await mint(h, sub.artworkId, 1, { edition: 1 })).status).toBe(201);
    expect((await mint(h, sub.artworkId, 1, { edition: 1 })).status).toBe(200); // replay
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).body).toMatchObject({ mintedEditions: 1, soldOut: false });
    expect((await mint(h, sub.artworkId, 2, { edition: 2 })).status).toBe(201);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).body).toMatchObject({ mintedEditions: 2, soldOut: true });
    // The chain is the truth: a quote issued before the cap was reached still lands and is recorded.
    expect((await mint(h, sub.artworkId, 3, { edition: 3 })).status).toBe(201);
    expect((await api(h, 'GET', `/v1/artworks/${sub.artworkId}`)).body).toMatchObject({ mintedEditions: 3, soldOut: true });
  });

  it('the edition is stored on the record; a replay with another edition is a conflict, one without it is the same record', async () => {
    const h = makeHarness();
    const s = await signIn(h, 8);
    const sub = await submit(h, s);
    const first = await mint(h, sub.artworkId, 1, { edition: 4 });
    expect(first.body.record.edition).toBe(4);
    const noEdition = await mint(h, sub.artworkId, 1);
    expect(noEdition.status).toBe(200);
    expect(noEdition.body.record.edition).toBe(4);
    const other = await mint(h, sub.artworkId, 1, { edition: 5 });
    expect(other.status).toBe(409);
    for (const edition of [0, -1, 1.5, '2']) expect((await mint(h, sub.artworkId, 9, { edition })).status, String(edition)).toBe(422);
    const royalties = await api(h, 'GET', '/v1/artists/me/royalties', { token: s.token });
    expect(royalties.body.items.map((r: { edition?: number }) => r.edition)).toEqual([4]);
  });

  it('records for other artworks do not count', async () => {
    const h = makeHarness();
    const s = await signIn(h, 9);
    const a = await submit(h, s);
    const b = await submit(h, s, { bytes: jpeg(1024, 1024, 210_000, 91) });
    await mint(h, a.artworkId, 1);
    await mint(h, a.artworkId, 2);
    await mint(h, b.artworkId, 3);
    expect((await api(h, 'GET', `/v1/artworks/${a.artworkId}`)).body.mintedEditions).toBe(2);
    expect((await api(h, 'GET', `/v1/artworks/${b.artworkId}`)).body.mintedEditions).toBe(1);
  });
});

describe('GET /v1/artworks?available=', () => {
  it('true hides sold-out pieces, false lists only them, anything else is 422', async () => {
    const h = makeHarness();
    const s = await signIn(h, 10);
    const open = await submit(h, s, { bytes: jpeg(1024, 1024, 210_000, 101) });
    const soldOut = await submit(h, s, { bytes: jpeg(1024, 1024, 210_000, 102) });
    const room = await submit(h, s, { bytes: jpeg(1024, 1024, 210_000, 103) });
    await setCap(h, s.token, soldOut.artworkId, 1);
    await setCap(h, s.token, room.artworkId, 2);
    await mint(h, soldOut.artworkId, 1);
    await mint(h, room.artworkId, 2);
    const ids = async (q: string) => ((await api(h, 'GET', `/v1/artworks${q}`)).body.items as Array<{ id: string }>).map((a) => a.id).sort();
    expect(await ids('')).toEqual([open.artworkId, soldOut.artworkId, room.artworkId].sort());
    expect(await ids('?available=true')).toEqual([open.artworkId, room.artworkId].sort());
    expect(await ids('?available=false')).toEqual([soldOut.artworkId]);
    expect((await api(h, 'GET', '/v1/artworks?available=true')).body.total).toBe(2);
    const bad = await api(h, 'GET', '/v1/artworks?available=yes');
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
  });
});
