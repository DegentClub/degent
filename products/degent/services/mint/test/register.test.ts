/**
 * The Register API and the collection statistics. The stats are checked against the known numbers of
 * the real roster (4,112 members, 1,508,497 KB, median ~371.6 KB) and the pure helpers against small
 * hand-computed inputs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExplorerResponse, StatsResponse } from '@bsh/degent-mint-sdk';
import { isoWeekStart, matchesQuery, median, parseRoster, sizeHistogram, sortMembers, topHolders, weekBuckets } from '../src/domain/roster.js';
import { SqliteOrderStore } from '../src/adapters/sqlite-order-store.js';
import { SqliteNonceStore, SqliteVoteStore } from '../src/adapters/vote-stores.js';
import { api, browserMintToPayment, fundAndApprove, fundToReview, makeHarness, regtestAddress, tinyRoster } from './fakes/harness.js';

const realRoster = parseRoster(JSON.parse(readFileSync(new URL('../data/roster.json', import.meta.url), 'utf8')));

describe('data/roster.json (built by scripts/build-roster.mjs from collection.json)', () => {
  it('holds the 4,112 Gallery members, numbered 1..4112 without gaps or duplicate ids', () => {
    expect(realRoster).toHaveLength(4112);
    expect(realRoster[0]).toMatchObject({ n: 1, inscriptionId: 'add1a568533d555dc3ac0a6db5b1ffa5d0f87d36b9b9059e4a8ce6bd7a94bfd3i0', inscriptionNumber: 93832030, sat: 969669989966969 });
    expect(realRoster[4111]).toMatchObject({ n: 4112, inscriptionId: 'c438b8faecb5a1ef0dd7367b9506d3316587e5a1618ef941b80c077e7afae914i0' });
    expect(realRoster.every((m) => m.sat !== null && m.inscriptionNumber !== null)).toBe(true);
  });

  it('matches the known totals: 1,508,497 KB in total, median ~371.6 KB', () => {
    const kb = realRoster.map((m) => m.sizeKb);
    expect(kb.reduce((a, b) => a + b, 0)).toBeCloseTo(1_508_497, 0);
    expect(median(kb)).toBeCloseTo(371.6, 0);
    const bytes = realRoster.map((m) => m.bytes);
    expect(Math.abs(bytes.reduce((a, b) => a + b, 0) / 1024 - 1_508_497)).toBeLessThan(3);
    expect(median(bytes) / 1024).toBeCloseTo(371.6, 0);
    expect(Math.min(...kb)).toBeGreaterThan(200);
    expect(Math.max(...kb)).toBeLessThan(4000);
  });

  it('GET /v1/stats over the real roster', async () => {
    const h = makeHarness({ roster: realRoster });
    const s = (await api(h, 'GET', '/v1/stats')).body as StatsResponse;
    expect(s.minted).toBe(4112);
    expect(s.charter).toBe(10_000);
    expect(Math.abs(s.totalBytes / 1024 - 1_508_497)).toBeLessThan(3);
    expect(s.medianBytes / 1024).toBeCloseTo(371.6, 0);
    expect(s.sizeHistogram.reduce((a, b) => a + b.count, 0)).toBe(4112);
    expect(s.sizeHistogram.find((b) => b.from === 0)!.count).toBe(0);
    expect(s.approvals).toMatchObject({ inReview: 0, approved: 0, declined: 0, perWeek: [], medianSecondsToQuorum: null });
    expect(s.mintsPerWeek).toEqual([]); // no timestamps in the offline roster
    expect((await api(h, 'GET', '/v1/register')).body).toMatchObject({ count: 4112, pending: 0, gallery: null });
  });

  it('parseRoster rejects gaps, duplicates and malformed ids', () => {
    const ok = tinyRoster();
    expect(parseRoster({ members: ok })).toHaveLength(5);
    expect(() => parseRoster({ members: ok.filter((m) => m.n !== 3) })).toThrow(/gap/);
    expect(() => parseRoster({ members: [...ok, { ...ok[0]!, n: 6 }] })).toThrow(/duplicate/);
    expect(() => parseRoster({ members: [{ ...ok[0]!, inscriptionId: 'nope' }] })).toThrow(/inscription id/);
    expect(() => parseRoster({})).toThrow(/members/);
  });
});

describe('roster helpers', () => {
  it('median, weeks, histogram, top holders', () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(isoWeekStart('2026-09-23T12:00:00.000Z')).toBe('2026-09-21');
    expect(isoWeekStart('2026-09-21T00:00:00.000Z')).toBe('2026-09-21');
    expect(isoWeekStart('2026-09-27T23:59:59.000Z')).toBe('2026-09-21');
    expect(weekBuckets(['2026-09-23T12:00:00.000Z', '2026-09-27T12:00:00.000Z', '2026-09-28T12:00:00.000Z'])).toEqual([
      { week: '2026-09-21', count: 2 },
      { week: '2026-09-28', count: 1 },
    ]);
    const hist = sizeHistogram([150 * 1024, 200 * 1024, 389 * 1024, 390 * 1024, 5000 * 1024]);
    expect(hist.find((b) => b.from === 0)!.count).toBe(1);
    expect(hist.find((b) => b.from === 200)!.count).toBe(1);
    expect(hist.find((b) => b.from === 350)!.count).toBe(1);
    expect(hist.find((b) => b.from === 390)!.count).toBe(1);
    expect(hist.at(-1)).toEqual({ from: 4000, to: null, count: 1 });
    expect(topHolders(['a', 'b', 'a', null, 'c', 'b', 'a'], 2)).toEqual([{ owner: 'a', count: 3 }, { owner: 'b', count: 2 }]);
  });

  it('sorting and querying members', () => {
    const ms = tinyRoster().map((m) => ({ n: m.n, id: m.inscriptionId, number: m.inscriptionNumber, via: 'gallery' as const, bytes: m.bytes, height: m.height, sat: m.sat, owner: m.n === 2 ? 'bc1pOwner' : null, contentUrl: '' }));
    expect(sortMembers(ms, 'bytes', 'desc').map((m) => m.n)).toEqual([5, 4, 3, 2, 1]);
    expect(sortMembers(ms, 'height', 'asc').map((m) => m.n)).toEqual([2, 3, 4, 5, 1]); // #1 (height unknown) falls back to its inscription number, i.e. last
    expect(sortMembers(ms, 'n', 'desc')[0]!.n).toBe(5);
    expect(ms.filter((m) => matchesQuery(m, '#2')).map((m) => m.n)).toEqual([2]);
    expect(ms.filter((m) => matchesQuery(m, '3')).map((m) => m.n)).toEqual([3]);
    expect(ms.filter((m) => matchesQuery(m, ms[3]!.id.slice(0, 10))).map((m) => m.n)).toEqual([4]);
    expect(ms.filter((m) => matchesQuery(m, 'bc1pow')).map((m) => m.n)).toEqual([2]);
    expect(ms.filter((m) => matchesQuery(m, '  ')).length).toBe(5);
  });
});

describe('Register API', () => {
  it('summary, member lookup with owner, holder check, verification', async () => {
    const h = makeHarness();
    expect((await api(h, 'GET', '/v1/register')).body).toMatchObject({ parent: h.settings.collection.parentInscriptionId, gallery: null, count: 5, bytes: tinyRoster().reduce((a, m) => a + m.bytes, 0), pending: 0 });
    const m1 = await api(h, 'GET', '/v1/register/1');
    expect(m1.body).toMatchObject({ n: 1, via: 'gallery', owner: regtestAddress(101), contentUrl: `https://ord.test/content/${h.roster[0]!.inscriptionId}`, height: null });
    expect((await api(h, 'GET', '/v1/register/6')).status).toBe(404);
    expect((await api(h, 'GET', '/v1/register/abc')).status).toBe(404);
    expect((await api(h, 'GET', '/v1/register/99999')).status).toBe(404);
    expect((await api(h, 'GET', `/v1/register/holder/${regtestAddress(200)}`)).body).toEqual({ address: regtestAddress(200), holder: true, degents: [100, 101] });
    expect((await api(h, 'GET', `/v1/register/holder/${regtestAddress(7)}`)).body).toMatchObject({ holder: false, degents: [] });
    expect((await api(h, 'GET', '/v1/register/holder/nope')).status).toBe(422);
    expect((await api(h, 'GET', `/v1/register/verify/${h.roster[2]!.inscriptionId}`)).body).toEqual({ id: h.roster[2]!.inscriptionId, member: true, via: 'gallery', n: 3 });
    expect((await api(h, 'GET', `/v1/register/verify/${'e'.repeat(64)}i0`)).body).toMatchObject({ member: false, via: null, n: null });
    expect((await api(h, 'GET', '/v1/register/verify/not-an-id')).status).toBe(422);
  });

  it('explorer: pagination, sorting, filtering, validation', async () => {
    const h = makeHarness();
    const page = (await api(h, 'GET', '/v1/explorer?limit=2&offset=1&sort=bytes&order=desc')).body as ExplorerResponse;
    expect(page).toMatchObject({ total: 5, offset: 1, limit: 2, sort: 'bytes', order: 'desc' });
    expect(page.items.map((m) => m.n)).toEqual([4, 3]);
    expect(page.items[0]!.owner).toBe(regtestAddress(104));
    const dflt = (await api(h, 'GET', '/v1/explorer')).body as ExplorerResponse;
    expect(dflt).toMatchObject({ offset: 0, limit: 48, sort: 'n', order: 'asc' });
    expect(dflt.items.map((m) => m.n)).toEqual([1, 2, 3, 4, 5]);
    const byOwner = (await api(h, 'GET', `/v1/explorer?q=${regtestAddress(102).slice(0, 12)}`)).body as ExplorerResponse;
    expect(byOwner.items.map((m) => m.n)).toEqual([2]);
    expect(((await api(h, 'GET', '/v1/explorer?q=%234')).body as ExplorerResponse).items.map((m) => m.n)).toEqual([4]);
    expect(((await api(h, 'GET', `/v1/explorer?q=${h.roster[4]!.inscriptionId.slice(0, 8)}`)).body as ExplorerResponse).total).toBe(1);
    // tier / size filters (tiny roster: 308,224 .. 312,320 bytes, all Standard)
    expect(((await api(h, 'GET', '/v1/explorer?tier=standard')).body as ExplorerResponse).total).toBe(5);
    expect(((await api(h, 'GET', '/v1/explorer?tier=block')).body as ExplorerResponse).total).toBe(0);
    expect(((await api(h, 'GET', '/v1/explorer?minBytes=310000')).body as ExplorerResponse).items.map((m) => m.n)).toEqual([3, 4, 5]);
    expect(((await api(h, 'GET', '/v1/explorer?maxBytes=309000&tier=standard')).body as ExplorerResponse).items.map((m) => m.n)).toEqual([1]);
    for (const bad of ['limit=0', 'limit=201', 'offset=-1', 'sort=owner', 'order=up', `q=${'x'.repeat(101)}`, 'tier=huge', 'minBytes=-1', 'minBytes=5&maxBytes=4']) {
      const r = await api(h, 'GET', `/v1/explorer?${bad}`);
      expect(r.status, bad).toBe(422);
    }
  });

  it('approved and delivered children join the Register and the stats', async () => {
    const h = makeHarness();
    const a = await browserMintToPayment(h, { recipientSeed: 42 });
    await fundAndApprove(h, a);
    const b = await browserMintToPayment(h, { recipientSeed: 43 });
    await fundToReview(h, b);
    expect((await api(h, 'GET', '/v1/register')).body).toMatchObject({ count: 5, pending: 1 });
    await h.worker.tick(); // reveal a
    h.chain.mine();
    await h.worker.tick(); // confirmed
    const o = (await api(h, 'GET', `/v1/orders/${a.orderId}`)).body;
    h.chain.inscriptions.set(o.inscriptionId, a.bytes);
    await h.worker.tick(); // verified + delivered
    expect((await api(h, 'GET', `/v1/orders/${a.orderId}`)).body.status).toBe('delivered');
    const reg = await api(h, 'GET', '/v1/register');
    expect(reg.body).toMatchObject({ count: 6, pending: 0 });
    const m = await api(h, 'GET', '/v1/register/4113');
    expect(m.body).toMatchObject({ n: 4113, id: o.inscriptionId, via: 'child', owner: regtestAddress(42), bytes: a.bytes.length, height: 101 });
    const ex = (await api(h, 'GET', '/v1/explorer?sort=n&order=desc&limit=1')).body as ExplorerResponse;
    expect(ex.items[0]!.n).toBe(4113);
    expect(((await api(h, 'GET', '/v1/explorer?sort=height&order=asc&limit=1')).body as ExplorerResponse).items[0]!.n).toBe(4113); // regtest block 101
    const s = (await api(h, 'GET', '/v1/stats')).body as StatsResponse;
    expect(s.minted).toBe(6);
    expect(s.approvals).toMatchObject({ inReview: 1, approved: 1, declined: 0, medianSecondsToQuorum: 0 });
    expect(s.approvals.perWeek).toEqual([{ week: '2026-09-21', count: 1 }]);
    expect(s.mintsPerWeek.reduce((x, w) => x + w.count, 0)).toBe(5); // 4 roster timestamps + the delivered child
    // five Gallery holders (one each) plus the child's recipient
    expect(s.topHolders.map((t) => t.count)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(s.topHolders.map((t) => t.owner)).toContain(regtestAddress(42));
  });
});

describe('sqlite vote and nonce stores', () => {
  it('votes are unique per (order, address) and listable by order and voter', async () => {
    const db = new SqliteOrderStore(':memory:');
    const votes = new SqliteVoteStore(db.database);
    const v = { orderId: 'o1', voterAddress: 'a', voterDegent: 7, vote: 'approve' as const, at: '2026-09-23T12:00:00.000Z', signature: 'AA==', message: 'm' };
    await votes.add(v);
    await votes.add({ ...v, voterAddress: 'b', voterDegent: 8 });
    await votes.add({ ...v, orderId: 'o2' });
    await expect(votes.add(v)).rejects.toThrow(/already exists/);
    expect((await votes.listByOrder('o1')).map((x) => x.voterDegent)).toEqual([7, 8]);
    expect((await votes.listByVoter('a')).map((x) => x.orderId)).toEqual(['o1', 'o2']);
    expect(await votes.listByOrder('o1')).toEqual([v, { ...v, voterAddress: 'b', voterDegent: 8 }]);
    db.close();
  });

  it('nonces are single-use, bound to domain + address, and expire', async () => {
    const db = new SqliteOrderStore(':memory:');
    const nonces = new SqliteNonceStore(db.database);
    const t0 = Date.now();
    const rec = { nonce: 'abcdef0123456789', expiresAt: t0 + 60_000, domain: 'degent.club', address: 'bc1p' };
    await nonces.issue(rec);
    await expect(nonces.issue(rec)).rejects.toThrow(/already issued/);
    expect(await nonces.consume('zzzz', { domain: 'degent.club', address: 'bc1p' }, t0)).toBe('unknown');
    expect(await nonces.consume(rec.nonce, { domain: 'other', address: 'bc1p' }, t0)).toBe('unknown');
    expect(await nonces.consume(rec.nonce, { domain: 'degent.club', address: 'bc1p' }, t0)).toBe('ok');
    expect(await nonces.consume(rec.nonce, { domain: 'degent.club', address: 'bc1p' }, t0)).toBe('replayed');
    await nonces.issue({ ...rec, nonce: 'expired00000000' });
    expect(await nonces.consume('expired00000000', { domain: 'degent.club', address: 'bc1p' }, t0 + 60_001)).toBe('expired');
    // long-expired nonces are swept on the next issue
    await nonces.issue({ ...rec, nonce: 'ancient000000000', expiresAt: t0 - 120_000 });
    await nonces.issue({ ...rec, nonce: 'fresh00000000000' });
    expect(await nonces.consume('ancient000000000', { domain: 'degent.club', address: 'bc1p' }, t0)).toBe('unknown');
    db.close();
  });
});
