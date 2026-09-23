import { describe, it, expect, vi } from 'vitest';
import { openDb, prepareStatements, LISTING_STATUS as S } from '../src/db.js';
import { nextState, createSettlementWatcher } from '../src/settlement-watcher.js';
import { createMempoolClient, createInscriptionIndexer } from '../src/indexer.js';
import { TXIDS, INSCRIPTION_ID } from './helpers.js';

const SELLER = 'bc1pseller';
const LOC = `${TXIDS.inscription}:1`;
const base = { id: INSCRIPTION_ID, location: LOC, seller_address: SELLER, price_sats: 50_000, status: S.ACTIVE, expires_at: '2999-01-01T00:00:00Z', updated_at: new Date().toISOString() };

describe('nextState', () => {
  it('active → sold when the outpoint is spent by a tx paying the seller the price', () => {
    const r = nextState(base, { outspend: { spent: true, txid: 'ff'.repeat(32) }, spendingTx: { vout: [{ scriptpubkey_address: 'bc1pbuyer', value: 10_000 }, { scriptpubkey_address: SELLER, value: 50_000 }] } });
    expect(r.status).toBe(S.SOLD);
    expect(r.txid).toBe('ff'.repeat(32));
  });
  it('active → invalid when spent by anything else (seller moved it)', () => {
    const r = nextState(base, { outspend: { spent: true, txid: 'ee'.repeat(32) }, spendingTx: { vout: [{ scriptpubkey_address: 'bc1pelsewhere', value: 10_000 }] } });
    expect(r.status).toBe(S.INVALID);
  });
  it('active → invalid when the indexer shows the inscription elsewhere or with another owner', () => {
    expect(nextState(base, { outspend: { spent: false }, inscription: { outpoint: 'aa'.repeat(32) + ':0', address: SELLER } }).status).toBe(S.INVALID);
    expect(nextState(base, { outspend: { spent: false }, inscription: { outpoint: LOC, address: 'bc1pother' } }).status).toBe(S.INVALID);
    expect(nextState(base, { outspend: { spent: false }, inscription: null }).status).toBe(S.INVALID);
  });
  it('active stays active when everything checks out', () => {
    expect(nextState(base, { outspend: { spent: false }, inscription: { outpoint: LOC, address: SELLER } })).toBeNull();
    expect(nextState(base, { outspend: { spent: false }, inscription: undefined })).toBeNull(); // indexer unavailable this round
  });
  it('active → expired after expires_at', () => {
    expect(nextState({ ...base, expires_at: '2000-01-01T00:00:00Z' }, { outspend: { spent: false } }).status).toBe(S.EXPIRED);
  });
  it('pending → sold once the spend is visible; pending → active after the timeout', () => {
    const pending = { ...base, status: S.PENDING, updated_at: new Date(Date.now() - 10 * 3600e3).toISOString() };
    expect(nextState(pending, { outspend: { spent: true, txid: 'ff'.repeat(32) }, spendingTx: { vout: [{ scriptpubkey_address: SELLER, value: 50_000 }] } }).status).toBe(S.SOLD);
    expect(nextState(pending, { outspend: { spent: false }, inscription: { outpoint: LOC, address: SELLER } }).status).toBe(S.ACTIVE);
    const fresh = { ...base, status: S.PENDING, updated_at: new Date().toISOString() };
    expect(nextState(fresh, { outspend: { spent: false }, inscription: { outpoint: LOC, address: SELLER } })).toBeNull();
  });
});

describe('settlement watcher tick (mocked fetch)', () => {
  function build(fetchImpl) {
    const db = openDb(':memory:');
    const stmts = prepareStatements(db);
    stmts.insertListing.run({
      id: INSCRIPTION_ID, inscription_number: 1, content_type: 'image/png', output_value: 10_000, location: LOC, sat_offset: 0,
      price_sats: 50_000, seller_address: SELLER, seller_pubkey: '02' + 'aa'.repeat(32), seller_sig_hex: '{}', seller_psbt_hex: 'ab', expires_at: '2999-01-01T00:00:00Z',
    });
    const fetchFn = vi.fn(fetchImpl);
    const mempool = createMempoolClient({ baseUrl: 'https://mempool.test/api', fetch: fetchFn });
    const indexer = createInscriptionIndexer({ kind: 'ord', ordApi: 'https://ord.test', fetch: fetchFn });
    const watcher = createSettlementWatcher({ db, stmts, mempool, indexer, logger: { info() {}, warn() {}, error() {} } });
    return { stmts, watcher, fetchFn };
  }
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

  it('marks a listing sold from an outspend + spending tx', async () => {
    const { stmts, watcher, fetchFn } = build(async (url) => {
      if (url.endsWith(`/tx/${TXIDS.inscription}/outspend/1`)) return json({ spent: true, txid: 'cc'.repeat(32) });
      if (url.endsWith(`/tx/${'cc'.repeat(32)}`)) return json({ vout: [{ scriptpubkey_address: 'bc1pbuyer', value: 10_000 }, { scriptpubkey_address: SELLER, value: 50_000 }] });
      return json({}, 404);
    });
    const res = await watcher.tick();
    expect(res.changes).toHaveLength(1);
    expect(stmts.getListing.get(INSCRIPTION_ID).status).toBe(S.SOLD);
    expect(stmts.getListing.get(INSCRIPTION_ID).settlement_txid).toBe('cc'.repeat(32));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('marks a listing invalid when the seller moved the inscription', async () => {
    const { stmts, watcher } = build(async (url) => {
      if (url.includes('/outspend/')) return json({ spent: false });
      if (url.includes('/r/inscription/')) return json({ id: INSCRIPTION_ID, address: SELLER, satpoint: 'dd'.repeat(32) + ':0:0', output: 'dd'.repeat(32) + ':0', value: 10_000 });
      return json({}, 404);
    });
    await watcher.tick();
    const row = stmts.getListing.get(INSCRIPTION_ID);
    expect(row.status).toBe(S.INVALID);
    expect(row.status_reason).toMatch(/moved/);
  });

  it('leaves a healthy listing active and records the check', async () => {
    const { stmts, watcher } = build(async (url) => {
      if (url.includes('/outspend/')) return json({ spent: false });
      if (url.includes('/r/inscription/')) return json({ id: INSCRIPTION_ID, address: SELLER, satpoint: `${LOC}:0`, output: LOC, value: 10_000 });
      return json({}, 404);
    });
    const res = await watcher.tick();
    expect(res.changes).toHaveLength(0);
    expect(stmts.getListing.get(INSCRIPTION_ID).status).toBe(S.ACTIVE);
    expect(stmts.getListing.get(INSCRIPTION_ID).last_checked_at).toBeTruthy();
  });

  it('tolerates upstream failures without changing state', async () => {
    const { stmts, watcher } = build(async () => json({ error: 'boom' }, 500));
    await watcher.tick();
    expect(stmts.getListing.get(INSCRIPTION_ID).status).toBe(S.ACTIVE);
  });
});
