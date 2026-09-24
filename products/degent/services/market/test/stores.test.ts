/** ListingStore / BuySessionStore / NonceStore adapters: memory and node:sqlite behave the same. */
import { describe, expect, it } from 'vitest';
import type { NonceStore } from '@bsh/identity';
import { InMemoryNonceStore } from '@bsh/identity';
import { MemoryMarketStore } from '../src/adapters/memory-store.js';
import { SqliteMarketStore, SqliteNonceStore } from '../src/adapters/sqlite-store.js';
import { StaleWriteError } from '../src/domain/errors.js';
import type { BuySession, ListingRecord } from '../src/domain/listing.js';
import { INSCRIPTION_ID } from './fakes/keys.js';

const record = (over: Partial<ListingRecord> = {}): ListingRecord => ({
  inscriptionId: INSCRIPTION_ID, inscriptionNumber: 1, degent: { via: 'gallery', n: 1 }, contentType: 'image/webp', outputValue: 10_000,
  location: `${'a1'.repeat(32)}:1`, satOffset: 0, priceSats: 50_000, sellerAddress: 'bcrt1pseller', sellerPublicKey: '02'.padEnd(66, 'a'),
  sellerSignature: { kind: 'schnorr', signatureHex: '00'.repeat(64) + '83' }, status: 'active', statusReason: null, settlementTxid: null, buyerAddress: null,
  createdAt: '2026-09-24T12:00:00.000Z', updatedAt: '2026-09-24T12:00:00.000Z', expiresAt: '2026-10-24T12:00:00.000Z', lastCheckedAt: null, version: 0, ...over,
});
const session = (over: Partial<BuySession> = {}): BuySession => ({
  id: 'ab'.repeat(16), inscriptionId: INSCRIPTION_ID, buyerAddress: 'bcrt1pbuyer', kind: 'buy', psbtHex: '70736274ff', buyerInputIndexes: [0, 1, 3],
  prevouts: [['x:0', '600']], guard: { satOffset: 0, postage: 10_000, buyerScriptHex: '5120' }, status: 'open', txid: null,
  createdAt: '2026-09-24T12:00:00.000Z', expiresAt: '2026-09-24T12:10:00.000Z', ...over,
});

const stores = { memory: () => new MemoryMarketStore(), sqlite: () => new SqliteMarketStore(':memory:') };

for (const [name, make] of Object.entries(stores)) {
  describe(`${name} market store`, () => {
    it('insert/get/save with optimistic versions; lists by status', async () => {
      const s = make();
      await s.insert(record());
      const got = (await s.get(INSCRIPTION_ID))!;
      expect(got.priceSats).toBe(50_000);
      const saved = await s.save({ ...got, status: 'pending' });
      expect(saved.version).toBe(1);
      await expect(s.save({ ...got, status: 'sold' })).rejects.toBeInstanceOf(StaleWriteError);
      expect((await s.listByStatus(['pending'])).map((r) => r.inscriptionId)).toEqual([INSCRIPTION_ID]);
      expect(await s.listByStatus([])).toEqual([]);
    });

    it('refuses a second open listing but replaces a closed one', async () => {
      const s = make();
      await s.insert(record());
      await expect(s.insert(record({ priceSats: 1 }))).rejects.toThrow();
      const cur = (await s.get(INSCRIPTION_ID))!;
      await s.save({ ...cur, status: 'cancelled' });
      await s.insert(record({ priceSats: 70_000, createdAt: '2026-09-25T00:00:00.000Z' }));
      expect((await s.get(INSCRIPTION_ID))!.priceSats).toBe(70_000);
      // a write based on the old row (other createdAt) is stale
      await expect(s.save({ ...cur, version: 0 })).rejects.toBeInstanceOf(StaleWriteError);
    });

    it('buy sessions: claim once, release on failure, finish with a txid, purge expired open ones', async () => {
      const s = make();
      await s.createSession(session());
      expect(await s.claimSession('ab'.repeat(16))).toBe(true);
      expect(await s.claimSession('ab'.repeat(16))).toBe(false);
      await s.finishSession('ab'.repeat(16), 'released');
      expect((await s.getSession('ab'.repeat(16)))!.status).toBe('open');
      expect(await s.claimSession('ab'.repeat(16))).toBe(true);
      await s.finishSession('ab'.repeat(16), { txid: 'cd'.repeat(32) });
      expect(await s.getSession('ab'.repeat(16))).toMatchObject({ status: 'broadcast', txid: 'cd'.repeat(32) });
      await s.createSession(session({ id: 'ef'.repeat(16) }));
      expect(await s.purgeSessions('2026-09-24T13:00:00.000Z')).toBe(1);
      expect(await s.getSession('ef'.repeat(16))).toBeNull();
      expect(await s.getSession('ab'.repeat(16))).not.toBeNull();
    });
  });
}

const nonceStores: Record<string, () => NonceStore> = {
  memory: () => new InMemoryNonceStore(),
  sqlite: () => new SqliteNonceStore(new SqliteMarketStore(':memory:').db),
};
for (const [name, make] of Object.entries(nonceStores)) {
  it(`${name} nonce store: single use, bound to domain+address, expiring`, async () => {
    const n = make();
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    await n.issue({ nonce: 'n1n1n1n1n1n1n1n1', domain: 'd', address: 'a', expiresAt: now + 60_000 });
    expect(await n.consume('n1n1n1n1n1n1n1n1', { domain: 'd', address: 'other' }, now)).toBe('unknown');
    expect(await n.consume('n1n1n1n1n1n1n1n1', { domain: 'd', address: 'a' }, now)).toBe('ok');
    expect(await n.consume('n1n1n1n1n1n1n1n1', { domain: 'd', address: 'a' }, now)).toBe('replayed');
    await n.issue({ nonce: 'n2n2n2n2n2n2n2n2', domain: 'd', address: 'a', expiresAt: now + 60_000 });
    expect(await n.consume('n2n2n2n2n2n2n2n2', { domain: 'd', address: 'a' }, now + 61_000)).toBe('expired');
    expect(await n.consume('never-issued-xxxx', { domain: 'd', address: 'a' }, now)).toBe('unknown');
    await expect(n.issue({ nonce: 'n1n1n1n1n1n1n1n1', domain: 'd', address: 'a', expiresAt: now })).rejects.toThrow();
  });
}
