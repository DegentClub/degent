/** Store parity: the memory and sqlite adapters must behave identically for every port. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryNonceStore, type NonceStore } from '@bsh/identity';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { FsContentStore, MemoryContentStore } from '../src/adapters/content-stores.js';
import { MemoryArtistStore, MemoryArtworkStore, MemoryRoyaltyStore, galleryOrder } from '../src/adapters/memory-stores.js';
import { SqliteStudioStore } from '../src/adapters/sqlite-store.js';
import type { ArtistRecord } from '../src/domain/artist.js';
import type { AppealRecord, ArtworkRecord } from '../src/domain/artwork.js';
import { StaleWriteError } from '../src/domain/errors.js';
import type { RoyaltyRecord } from '../src/domain/royalty.js';
import type { ArtistStore } from '../src/ports/artist-store.js';
import type { ArtworkStore } from '../src/ports/artwork-store.js';
import type { RoyaltyStore } from '../src/ports/royalty-store.js';

const dir = mkdtempSync(join(tmpdir(), 'degent-studio-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T = (i: number) => new Date(Date.UTC(2026, 8, 24, 12, 0, i)).toISOString();

function artist(address: string, at = T(0)): ArtistRecord {
  return { address, network: 'regtest', displayName: null, payoutAddress: null, payoutVerifiedAt: null, joinedAt: at, updatedAt: at, version: 0 };
}

function artwork(id: string, p: Partial<ArtworkRecord> = {}): ArtworkRecord {
  const at = p.createdAt ?? T(0);
  return {
    id, artist: 'bcrt1alice', network: 'regtest', title: id, description: null, contentType: 'image/jpeg', contentLength: 250_000, contentSha256: null,
    status: 'approved', needsHuman: false, review: null, featured: false, featuredAt: null, timeline: [{ status: 'submitted', at }], createdAt: at, updatedAt: at,
    version: 0, uploadTokenHash: 'c'.repeat(64), ...p,
  };
}

function royalty(orderId: string, p: Partial<RoyaltyRecord> = {}): RoyaltyRecord {
  return { orderId, artworkId: 'art_1', artist: 'bcrt1alice', minterAddress: null, royaltySats: 1000, fundingTxid: 'a'.repeat(64), vout: 1, at: T(0), recordedAt: T(0), ...p };
}

interface Bundle {
  artists: ArtistStore;
  artworks: ArtworkStore;
  royalties: RoyaltyStore;
  nonces: NonceStore;
}

const makers: Array<[string, () => Bundle]> = [
  ['memory', () => ({ artists: new MemoryArtistStore(), artworks: new MemoryArtworkStore(), royalties: new MemoryRoyaltyStore(), nonces: new InMemoryNonceStore() })],
  ['sqlite :memory:', () => new SqliteStudioStore(':memory:')],
  ['sqlite file', () => new SqliteStudioStore(join(dir, `studio-${Math.random()}.db`))],
];

describe.each(makers)('ArtistStore contract: %s', (_n, make) => {
  it('create / get / save with optimistic concurrency and copy isolation', async () => {
    const s = make().artists;
    await s.create(artist('a'));
    await expect(s.create(artist('a'))).rejects.toThrow();
    const a = (await s.get('a'))!;
    expect(a.version).toBe(0);
    const saved = await s.save({ ...a, displayName: 'Alice' });
    expect(saved.version).toBe(1);
    await expect(s.save({ ...a, displayName: 'Stale' })).rejects.toBeInstanceOf(StaleWriteError);
    expect((await s.get('a'))!.displayName).toBe('Alice');
    expect(await s.get('nope')).toBeNull();
    const got = (await s.get('a'))!;
    got.displayName = 'mutated';
    expect((await s.get('a'))!.displayName).toBe('Alice');
  });
});

describe.each(makers)('ArtworkStore contract: %s', (_n, make) => {
  it('create / get / save with optimistic concurrency', async () => {
    const s = make().artworks;
    await s.create(artwork('x'));
    await expect(s.create(artwork('x'))).rejects.toThrow();
    const a = (await s.get('x'))!;
    const saved = await s.save({ ...a, status: 'delisted' });
    expect(saved.version).toBe(1);
    await expect(s.save({ ...a, status: 'rejected' })).rejects.toBeInstanceOf(StaleWriteError);
    expect((await s.get('x'))!.status).toBe('delisted');
    expect(await s.get('nope')).toBeNull();
  });

  it('lists featured first, then newest, with filters and paging', async () => {
    const s = make().artworks;
    await s.create(artwork('a1', { createdAt: T(1) }));
    await s.create(artwork('a2', { createdAt: T(2) }));
    await s.create(artwork('a3', { createdAt: T(3), featured: true, featuredAt: T(9) }));
    await s.create(artwork('a4', { createdAt: T(4), status: 'reviewing', needsHuman: true }));
    await s.create(artwork('b1', { createdAt: T(5), artist: 'bcrt1bob' }));
    await s.create(artwork('b2', { createdAt: T(6), artist: 'bcrt1bob', status: 'delisted' }));
    await s.create(artwork('a0', { createdAt: T(1), featured: true, featuredAt: T(8) })); // same createdAt as a1
    const all = await s.list({ status: 'approved', page: 1, pageSize: 10 });
    expect(all.total).toBe(5);
    expect(all.items.map((r) => r.id)).toEqual(['a3', 'a0', 'b1', 'a2', 'a1']);
    const p2 = await s.list({ status: 'approved', page: 2, pageSize: 2 });
    expect(p2.items.map((r) => r.id)).toEqual(['b1', 'a2']);
    expect(p2.total).toBe(5);
    const bob = await s.list({ artist: 'bcrt1bob', page: 1, pageSize: 10 });
    expect(bob.items.map((r) => r.id)).toEqual(['b2', 'b1']);
    const queue = await s.list({ status: 'reviewing', page: 1, pageSize: 10 });
    expect(queue.items.map((r) => r.id)).toEqual(['a4']);
    expect((await s.list({ page: 1, pageSize: 3 })).total).toBe(7);
    expect((await s.list({ status: 'approved', artist: 'nobody', page: 1, pageSize: 3 })).items).toEqual([]);
  });

  it('counts per artist', async () => {
    const s = make().artworks;
    await s.create(artwork('a1'));
    await s.create(artwork('a2', { status: 'rejected' }));
    await s.create(artwork('a3', { status: 'submitted' }));
    await s.create(artwork('b1', { artist: 'bcrt1bob' }));
    expect(await s.countByArtist('bcrt1alice')).toEqual({ total: 3, approved: 1 });
    expect(await s.countByArtist('bcrt1bob')).toEqual({ total: 1, approved: 1 });
    expect(await s.countByArtist('nobody')).toEqual({ total: 0, approved: 0 });
  });

  it('ADR-0012 gallery order: featuredRank asc (featured only, unranked last), then featured, then newest', async () => {
    const s = make().artworks;
    await s.create(artwork('old', { createdAt: T(1) })); // a row from before ADR-0012 (no rank / edition fields)
    await s.create(artwork('r2', { createdAt: T(2), featured: true, featuredRank: 2 }));
    await s.create(artwork('r1', { createdAt: T(3), featured: true, featuredRank: 1 }));
    await s.create(artwork('r2b', { createdAt: T(4), featured: true, featuredRank: 2 }));
    await s.create(artwork('f', { createdAt: T(5), featured: true, featuredRank: null }));
    await s.create(artwork('stale', { createdAt: T(6), featured: false, featuredRank: 1 })); // a rank without featured does not count
    await s.create(artwork('new', { createdAt: T(7) }));
    const all = await s.list({ status: 'approved', page: 1, pageSize: 10 });
    expect(all.items.map((r) => r.id)).toEqual(['r1', 'r2b', 'r2', 'f', 'new', 'stale', 'old']);
    expect((await s.list({ status: 'approved', page: 2, pageSize: 3 })).items.map((r) => r.id)).toEqual(['f', 'new', 'stale']);
  });

  it('filters by availability (sold out = maxEditions set and mintedEditions >= it)', async () => {
    const s = make().artworks;
    await s.create(artwork('legacy'));
    await s.create(artwork('open', { maxEditions: null, mintedEditions: 50 }));
    await s.create(artwork('room', { maxEditions: 3, mintedEditions: 2 }));
    await s.create(artwork('full', { maxEditions: 3, mintedEditions: 3 }));
    await s.create(artwork('over', { maxEditions: 1, mintedEditions: 2 }));
    const ids = async (available?: boolean) =>
      (await s.list({ status: 'approved', page: 1, pageSize: 10, ...(available !== undefined ? { available } : {}) })).items.map((r) => r.id).sort();
    expect(await ids()).toEqual(['full', 'legacy', 'open', 'over', 'room']);
    expect(await ids(true)).toEqual(['legacy', 'open', 'room']);
    expect(await ids(false)).toEqual(['full', 'over']);
    expect((await s.list({ status: 'approved', available: true, page: 1, pageSize: 1 })).total).toBe(3);
  });

  it('lists appeals across artworks: oldest first, by status, paged; rows without appeals contribute none', async () => {
    const s = make().artworks;
    const ap = (artworkId: string, n: number, status: AppealRecord['status'], at: number): AppealRecord => ({
      id: `${artworkId}:appeal:${n}`,
      artworkId,
      artist: 'bcrt1alice',
      message: `m${n}`,
      status,
      createdAt: T(at),
      resolvedAt: status === 'open' ? null : T(at + 1),
      resolution: status === 'open' ? null : { decision: status === 'granted' ? 'approve' : 'reject', reasons: [], reviewerId: 'h', at: T(at + 1) },
    });
    await s.create(artwork('none'));
    await s.create(artwork('x', { status: 'reviewing', appeals: [ap('x', 1, 'denied', 1), ap('x', 2, 'open', 5)] }));
    await s.create(artwork('y', { status: 'reviewing', appeals: [ap('y', 1, 'open', 3)] }));
    await s.create(artwork('z', { status: 'approved', appeals: [ap('z', 1, 'granted', 2)] }));
    const open = await s.listAppeals({ status: 'open', page: 1, pageSize: 10 });
    expect(open.items.map((a) => a.id)).toEqual(['y:appeal:1', 'x:appeal:2']);
    expect(open.total).toBe(2);
    expect(open.items[0]).toEqual(ap('y', 1, 'open', 3));
    expect((await s.listAppeals({ page: 1, pageSize: 10 })).items.map((a) => a.id)).toEqual(['x:appeal:1', 'z:appeal:1', 'y:appeal:1', 'x:appeal:2']);
    const p2 = await s.listAppeals({ page: 2, pageSize: 3 });
    expect(p2.items.map((a) => a.id)).toEqual(['x:appeal:2']);
    expect(p2.total).toBe(4);
    expect((await s.listAppeals({ status: 'denied', page: 1, pageSize: 10 })).items.map((a) => a.id)).toEqual(['x:appeal:1']);
  });

  it('round-trips the full record (review, timeline, hashes)', async () => {
    const s = make().artworks;
    const rec = artwork('full', {
      contentSha256: 'd'.repeat(64),
      review: { automated: { approved: false, needsHuman: true, reasons: [], checks: [{ id: 'x', passed: false, detail: 'y' }], reviewer: 'rules+vision' }, house: null, reviewedAt: T(1) },
      timeline: [{ status: 'submitted', at: T(0) }, { status: 'reviewing', at: T(1), detail: 'd' }],
    });
    await s.create(rec);
    expect(await s.get('full')).toEqual(rec);
  });
});

describe.each(makers)('RoyaltyStore contract: %s', (_n, make) => {
  it('create once per order, lookup by order, list newest first with totals over all records', async () => {
    const s = make().royalties;
    await s.create(royalty('o1', { at: T(1), royaltySats: 100 }));
    await s.create(royalty('o2', { at: T(3), royaltySats: 250 }));
    await s.create(royalty('o3', { at: T(2), royaltySats: 50 }));
    await s.create(royalty('o4', { at: T(2), royaltySats: 1, artist: 'bcrt1bob' }));
    await expect(s.create(royalty('o1'))).rejects.toThrow();
    expect((await s.getByOrder('o2'))!.royaltySats).toBe(250);
    expect(await s.getByOrder('nope')).toBeNull();
    const page = await s.listByArtist('bcrt1alice', 1, 2);
    expect(page.items.map((r) => r.orderId)).toEqual(['o2', 'o3']);
    expect(page.total).toBe(3);
    expect(page.totals).toEqual({ records: 3, royaltySats: 400 });
    expect((await s.listByArtist('bcrt1alice', 2, 2)).items.map((r) => r.orderId)).toEqual(['o1']);
    expect(await s.listByArtist('nobody', 1, 10)).toEqual({ items: [], total: 0, totals: { records: 0, royaltySats: 0 } });
  });

  it('counts records per artwork and round-trips the edition', async () => {
    const s = make().royalties;
    await s.create(royalty('o1', { artworkId: 'art_a', edition: 1 }));
    await s.create(royalty('o2', { artworkId: 'art_a', edition: 2 }));
    await s.create(royalty('o3', { artworkId: 'art_b' }));
    expect(await s.countByArtwork('art_a')).toBe(2);
    expect(await s.countByArtwork('art_b')).toBe(1);
    expect(await s.countByArtwork('art_none')).toBe(0);
    expect((await s.getByOrder('o2'))!.edition).toBe(2);
    expect(await s.getByOrder('o3')).not.toHaveProperty('edition');
  });
});

describe.each(makers)('NonceStore contract: %s', (_n, make) => {
  it('issues once, consumes once, reports unknown / expired / replayed / wrong binding', async () => {
    const s = make().nonces;
    // The identity in-memory store sweeps entries already expired on the REAL clock at issue time.
    const t0 = Date.now() + 60 * 60 * 1000;
    const rec = { nonce: 'abcdef0123456789', expiresAt: t0 + 10_000, domain: 'd', address: 'a' };
    await s.issue(rec);
    await expect(s.issue(rec)).rejects.toThrow();
    expect(await s.consume('other', { domain: 'd', address: 'a' }, t0)).toBe('unknown');
    expect(await s.consume(rec.nonce, { domain: 'x', address: 'a' }, t0)).toBe('unknown');
    expect(await s.consume(rec.nonce, { domain: 'd', address: 'b' }, t0)).toBe('unknown');
    expect(await s.consume(rec.nonce, { domain: 'd', address: 'a' }, t0)).toBe('ok');
    expect(await s.consume(rec.nonce, { domain: 'd', address: 'a' }, t0)).toBe('replayed');
    await s.issue({ ...rec, nonce: 'expired000000000' });
    expect(await s.consume('expired000000000', { domain: 'd', address: 'a' }, t0 + 10_000)).toBe('expired');
  });
});

describe('sqlite specifics', () => {
  it('sweeps expired nonces and closes', () => {
    const s = new SqliteStudioStore(':memory:');
    void s.nonces.issue({ nonce: 'n1n1n1n1n1n1n1n1', expiresAt: 1000, domain: 'd', address: 'a' });
    void s.nonces.issue({ nonce: 'n2n2n2n2n2n2n2n2', expiresAt: 500_000, domain: 'd', address: 'a' });
    expect(s.sweepNonces(70_000)).toBe(1);
    expect(s.sweepNonces(70_000)).toBe(0);
    s.close();
  });

  it('a file store persists across reopen', async () => {
    const path = join(dir, 'persist.db');
    const a = new SqliteStudioStore(path);
    await a.artists.create(artist('z'));
    await a.artworks.create(artwork('z1', { artist: 'z' }));
    a.close();
    const b = new SqliteStudioStore(path);
    expect((await b.artists.get('z'))!.address).toBe('z');
    expect(await b.artworks.countByArtist('z')).toEqual({ total: 1, approved: 1 });
    b.close();
  });
});

describe('galleryOrder', () => {
  it('is featured desc, createdAt desc, id desc', () => {
    const rows = [artwork('b', { createdAt: T(1) }), artwork('a', { createdAt: T(1) }), artwork('c', { createdAt: T(0), featured: true }), artwork('d', { createdAt: T(2) })];
    expect([...rows].sort(galleryOrder).map((r) => r.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('puts ranked featured artworks first, lowest rank first (ADR-0012)', () => {
    const rows = [artwork('f', { featured: true, createdAt: T(9) }), artwork('r5', { featured: true, featuredRank: 5 }), artwork('r1', { featured: true, featuredRank: 1 }), artwork('n', { createdAt: T(10) })];
    expect([...rows].sort(galleryOrder).map((r) => r.id)).toEqual(['r1', 'r5', 'f', 'n']);
  });
});

describe.each([
  ['memory', () => new MemoryContentStore()],
  ['fs', () => new FsContentStore(join(dir, `content-${Math.random()}`))],
])('ContentStore contract: %s', (_n, make) => {
  it('is content-addressed, idempotent and copy-isolated', async () => {
    const s = make();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha = await s.put(bytes);
    expect(sha).toBe(sha256Hex(bytes));
    expect(await s.put(bytes)).toBe(sha);
    expect(await s.has(sha)).toBe(true);
    expect(await s.has('0'.repeat(64))).toBe(false);
    const got = (await s.get(sha))!;
    expect([...got]).toEqual([1, 2, 3, 4]);
    got[0] = 9;
    expect([...(await s.get(sha))!]).toEqual([1, 2, 3, 4]);
    expect(await s.get('0'.repeat(64))).toBeNull();
  });
});
