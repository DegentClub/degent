/** Settlement watcher: the pure transition function, and ticks against a mocked chain / ord. */
import { describe, expect, it } from 'vitest';
import { nextState, type ChainFacts } from '../src/domain/listing.js';
import { LOC, listViaApi, makeHarness } from './fakes/harness.js';
import { INSCRIPTION_ID } from './fakes/keys.js';

const SELLER = 'bcrt1pseller';
const now = new Date('2026-09-24T12:00:00.000Z');
const base = { location: LOC, sellerAddress: SELLER, priceSats: 50_000, status: 'active' as const, expiresAt: '2999-01-01T00:00:00.000Z', updatedAt: now.toISOString() };
const opts = { now, pendingTimeoutMs: 6 * 3600_000 };
const out = (address: string, value: number) => ({ address, value: BigInt(value), scriptHex: '' });
const spent = (txid: string, vout: ReturnType<typeof out>[]): ChainFacts => ({ outspend: { spent: true, txid }, spendingTx: { txid, vout, confirmed: false } });

describe('nextState', () => {
  it('active → sold when the outpoint is spent by a tx paying the seller the price', () => {
    const r = nextState(base, spent('ff'.repeat(32), [out('bcrt1pbuyer', 10_000), out(SELLER, 50_000)]), opts);
    expect(r).toMatchObject({ status: 'sold', txid: 'ff'.repeat(32) });
  });

  it('matches the seller by script too (address-less outputs)', () => {
    const r = nextState(base, { outspend: { spent: true, txid: 'ab'.repeat(32) }, spendingTx: { txid: 'ab'.repeat(32), confirmed: true, vout: [{ address: null, scriptHex: '5120aa', value: 50_000n }] } }, { ...opts, sellerScriptHex: '5120aa' });
    expect(r?.status).toBe('sold');
  });

  it('active → invalid when spent by anything else (seller moved it, or paid less)', () => {
    expect(nextState(base, spent('ee'.repeat(32), [out('bcrt1pelsewhere', 10_000)]), opts)?.status).toBe('invalid');
    expect(nextState(base, spent('ee'.repeat(32), [out(SELLER, 49_999)]), opts)?.status).toBe('invalid');
  });

  it('a spend whose tx could not be fetched is decided next round', () => {
    expect(nextState(base, { outspend: { spent: true, txid: 'ee'.repeat(32) } }, opts)).toBeNull();
  });

  it('active → invalid when ord shows the inscription elsewhere, with another owner, or gone', () => {
    const loc = { id: INSCRIPTION_ID, number: 1, offset: 0, value: 10_000, contentType: '' };
    expect(nextState(base, { outspend: { spent: false, txid: null }, inscription: { ...loc, outpoint: `${'aa'.repeat(32)}:0`, address: SELLER } }, opts)?.status).toBe('invalid');
    expect(nextState(base, { outspend: { spent: false, txid: null }, inscription: { ...loc, outpoint: LOC, address: 'bcrt1pother' } }, opts)?.status).toBe('invalid');
    expect(nextState(base, { outspend: { spent: false, txid: null }, inscription: null }, opts)?.status).toBe('invalid');
  });

  it('active stays active when everything checks out or the indexer is down this round', () => {
    const loc = { id: INSCRIPTION_ID, number: 1, offset: 0, value: 10_000, contentType: '', outpoint: LOC, address: SELLER };
    expect(nextState(base, { outspend: { spent: false, txid: null }, inscription: loc }, opts)).toBeNull();
    expect(nextState(base, { outspend: { spent: false, txid: null } }, opts)).toBeNull();
  });

  it('active → expired after expiresAt; pending never expires', () => {
    expect(nextState({ ...base, expiresAt: '2000-01-01T00:00:00.000Z' }, { outspend: { spent: false, txid: null } }, opts)?.status).toBe('expired');
    expect(nextState({ ...base, status: 'pending', expiresAt: '2000-01-01T00:00:00.000Z' }, { outspend: { spent: false, txid: null } }, opts)).toBeNull();
  });

  it('pending → sold once the spend is visible; pending → active after the timeout', () => {
    const old = { ...base, status: 'pending' as const, updatedAt: new Date(now.getTime() - 10 * 3600_000).toISOString() };
    expect(nextState(old, spent('ff'.repeat(32), [out(SELLER, 50_000)]), opts)?.status).toBe('sold');
    expect(nextState(old, { outspend: { spent: false, txid: null } }, opts)).toMatchObject({ status: 'active', txid: null });
    const fresh = { ...base, status: 'pending' as const };
    expect(nextState(fresh, { outspend: { spent: false, txid: null } }, opts)).toBeNull();
  });
});

describe('SettlementWatcher.tick (mocked chain and ord)', () => {
  it('marks a listing invalid when the seller moved the inscription, publishing the event and wiping the signature', async () => {
    const h = makeHarness();
    await listViaApi(h);
    h.chain.spent.set(LOC, 'cc'.repeat(32));
    h.chain.txs.set('cc'.repeat(32), { txid: 'cc'.repeat(32), confirmed: true, vout: [{ value: 10_000n, scriptHex: '00', address: 'bcrt1qelsewhere' }] });
    const res = await h.watcher.tick();
    expect(res.changes).toEqual([expect.objectContaining({ to: 'invalid', txid: 'cc'.repeat(32) })]);
    const row = (await h.store.get(INSCRIPTION_ID))!;
    expect(row.status).toBe('invalid');
    expect(row.sellerSignature).toBeNull();
    expect(h.events_.at(-1)).toMatchObject({ type: 'degent.market.listing.invalid', previousStatus: 'active', txid: 'cc'.repeat(32) });
  });

  it('leaves a healthy listing active and records the check', async () => {
    const h = makeHarness();
    await listViaApi(h);
    h.clock.advance(5_000);
    const res = await h.watcher.tick();
    expect(res.changes).toHaveLength(0);
    const row = (await h.store.get(INSCRIPTION_ID))!;
    expect(row.status).toBe('active');
    expect(row.lastCheckedAt).toBe(h.clock.now().toISOString());
  });

  it('expires listings past their expiry', async () => {
    const h = makeHarness();
    await listViaApi(h);
    h.clock.advance(31 * 86_400_000);
    expect((await h.watcher.tick()).changes[0]).toMatchObject({ to: 'expired' });
  });

  it('tolerates upstream failures without changing state', async () => {
    const h = makeHarness();
    await listViaApi(h);
    h.chain.down = true;
    const res = await h.watcher.tick();
    expect(res.changes).toHaveLength(0);
    expect((await h.store.get(INSCRIPTION_ID))!.status).toBe('active');
    h.chain.down = false;
    h.ord.down = true;
    expect((await h.watcher.tick()).changes).toHaveLength(0);
  });

  it('re-opens a pending listing whose purchase never appeared', async () => {
    const h = makeHarness({ settings: { buysEnabled: true } });
    await listViaApi(h);
    const r = (await h.store.get(INSCRIPTION_ID))!;
    await h.store.save({ ...r, status: 'pending', settlementTxid: 'ab'.repeat(32) });
    h.clock.advance(7 * 3600_000);
    expect((await h.watcher.tick()).changes[0]).toMatchObject({ from: 'pending', to: 'active' });
  });
});
