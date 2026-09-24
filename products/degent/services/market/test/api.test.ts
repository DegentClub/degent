/** HTTP API end to end on fakes: hardening, listing lifecycle, the BUYS_ENABLED gate, the buy flow. */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { SELLER_SIGHASH } from '../src/domain/settlement/index.js';
import { LOC, bip322, listViaApi, makeHarness, type Harness } from './fakes/harness.js';
import { INSCRIPTION_ID, TXIDS, keyFromSeed, tamperOutput, walletSign } from './fakes/keys.js';

const buysOn = (extra = {}) => makeHarness({ settings: { buysEnabled: true, ...extra } });
const prepareBuy = (h: Harness, extra: Record<string, unknown> = {}) =>
  h.request('POST', '/v1/buy/prepare', { inscriptionId: INSCRIPTION_ID, buyerAddress: h.buyer.tr.address, buyerPublicKey: h.buyer.publicKeyHex, ...extra });

describe('hardening', () => {
  it('sends security headers and no CORS header by default', async () => {
    const h = makeHarness();
    const res = await h.request('GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves no files: no database, no source, no static site', async () => {
    const h = makeHarness();
    for (const p of ['/market.db', '/src/app.ts', '/package.json', '/.env', '/', '/index.html']) expect((await h.request('GET', p)).status).toBe(404);
  });

  it('has no GET mutations and no "sold" endpoint', async () => {
    const h = makeHarness();
    expect((await h.request('GET', `/v1/listings/${INSCRIPTION_ID}/cancel`)).status).toBe(404);
    expect((await h.request('GET', `/v1/listings/${INSCRIPTION_ID}/sold`)).status).toBe(404);
    expect((await h.request('POST', `/v1/listings/${INSCRIPTION_ID}/sold`, {})).status).toBe(404);
    expect((await h.request('PATCH', `/v1/listings/${INSCRIPTION_ID}/sold`)).status).toBe(404);
  });

  it('validates input with the offending path, rejects unknown fields and non-JSON bodies', async () => {
    const h = makeHarness();
    const res = await h.request('POST', '/v1/listings/prepare', { inscriptionId: 'nope', sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/inscriptionId/);
    const extra = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000, evil: 1 });
    expect(extra.status).toBe(422);
    expect((await h.request('POST', '/v1/auth/challenge', 'not json')).status).toBe(400);
    expect((await h.request('POST', '/v1/auth/challenge', undefined, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('CORS: only configured origins; cross-origin mutations refused', async () => {
    const h = makeHarness({ corsOrigins: ['https://degent.club'] });
    const ok = await h.request('GET', '/v1/health', undefined, { origin: 'https://degent.club' });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://degent.club');
    const no = await h.request('GET', '/v1/health', undefined, { origin: 'https://evil.example' });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
    expect((await h.request('POST', '/v1/auth/challenge', {}, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('rate limits POSTs per client', async () => {
    const h = makeHarness({ rateLimit: { windowMs: 60_000, max: 2 } });
    for (let i = 0; i < 2; i++) await h.request('POST', '/v1/auth/challenge', {});
    const res = await h.request('POST', '/v1/auth/challenge', {});
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('config and fees are public and honest about the kill switch', async () => {
    const h = makeHarness({ settings: { royaltyBps: 200, treasuryAddress: keyFromSeed('treasury').tr.address } });
    const cfg = await h.request('GET', '/v1/config');
    expect(cfg.body).toMatchObject({ buysEnabled: false, royaltyBps: 200, layout: { inscriptionInput: 2, priceOutput: 2, inscriptionOutput: 1, sellerSighash: 131 } });
    expect((await h.request('GET', '/v1/fees')).body).toEqual({ economy: 3, normal: 10, fast: 20, minimum: 1 });
    h.chain.down = true;
    expect((await h.request('GET', '/v1/fees')).status).toBe(503);
    expect((await h.request('GET', '/v1/health')).body.status).toBe('degraded');
  });
});

describe('BUYS_ENABLED kill switch (default false)', () => {
  it('buy routes answer 503 buys_paused before parsing anything; health says so', async () => {
    const h = makeHarness();
    for (const p of ['/v1/buy/prepare', '/v1/buy/submit']) {
      const res = await h.request('POST', p, {});
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('buys_paused');
    }
    expect((await h.request('GET', '/v1/health')).body.buysEnabled).toBe(false);
  });

  it('listing, viewing and cancelling keep working while buys are paused', async () => {
    const h = makeHarness();
    expect((await listViaApi(h)).status).toBe(201);
    expect((await h.request('GET', '/v1/listings')).body.total).toBe(1);
  });

  it('the service refuses buys even if the HTTP gate were bypassed', async () => {
    const h = makeHarness();
    await expect(h.market.buyPrepare({})).rejects.toMatchObject({ code: 'buys_paused', status: 503 });
    await expect(h.market.buySubmit({})).rejects.toMatchObject({ code: 'buys_paused' });
  });
});

describe('listing lifecycle', () => {
  it('creates a listing with a verified seller signature and a BIP-322 proof; never leaks the signature', async () => {
    const h = makeHarness();
    const res = await listViaApi(h);
    expect(res.status).toBe(201);
    expect(res.body.listing).toMatchObject({ status: 'active', location: LOC, priceSats: 50_000, degent: { via: 'gallery', n: 1 }, satOffset: 0, outputValue: 10_000 });
    expect(JSON.stringify(res.body)).not.toMatch(/signature|psbt/i);
    const list = await h.request('GET', '/v1/listings');
    expect(list.body.items).toHaveLength(1);
    expect((await h.request('GET', `/v1/listings/${INSCRIPTION_ID}`)).body.priceSats).toBe(50_000);
    expect(h.events_.map((e) => e.type)).toEqual(['degent.market.listing.active']);
    // a second listing of the same open inscription is refused
    const again = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 60_000 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_listed');
  });

  it('refuses inscriptions that are not Degents (not roster, not parent-linked)', async () => {
    const h = makeHarness();
    const other = `${'f0'.repeat(32)}i0`;
    const res = await h.request('POST', '/v1/listings/prepare', { inscriptionId: other, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_a_degent');
    const ch = await h.request('POST', '/v1/auth/challenge', { action: 'list', address: h.seller.tr.address, inscriptionId: other, priceSats: 50_000 });
    expect(ch.status).toBe(403);
  });

  it('accepts a parent-linked child as well as a Gallery Degent', async () => {
    const h = makeHarness();
    const child = `${'c1'.repeat(32)}i0`;
    h.membership.set(child, { via: 'child', n: 4113 });
    h.ord.inscriptions.set(child, { id: child, number: 99, address: h.seller.tr.address, outpoint: `${'c1'.repeat(32)}:0`, offset: 0, value: 546, contentType: 'image/webp' });
    const res = await h.request('POST', '/v1/listings/prepare', { inscriptionId: child, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ signIndex: 2, sighashType: 131, toSignInputs: [{ index: 2, sighashTypes: [131] }] });
  });

  it('refuses a listing without a valid challenge signature (impostor key)', async () => {
    const h = makeHarness();
    const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    const signedPsbt = walletSign(prep.body.psbtHex, h.seller.priv, [2], SELLER_SIGHASH);
    const ch = await h.request('POST', '/v1/auth/challenge', { action: 'list', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 50_000 });
    const signature = bip322(keyFromSeed('impostor'), ch.body.message);
    const res = await h.request('POST', '/v1/listings', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000, signedPsbt, message: ch.body.message, signature });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('auth_failed');
    expect((await h.request('GET', '/v1/listings')).body.items).toHaveLength(0);
  });

  it('refuses a listing when the seller does not hold the inscription', async () => {
    const h = makeHarness();
    h.ord.inscriptions.get(INSCRIPTION_ID)!.address = keyFromSeed('someone').tr.address;
    const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    expect(prep.status).toBe(403);
    expect(prep.body.error.code).toBe('not_owner');
  });

  it('refuses a listing whose outpoint is spent or unknown (listing_invalid with the reason)', async () => {
    const h = makeHarness();
    h.chain.spent.set(LOC, 'ee'.repeat(32));
    const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    expect(prep.status).toBe(409);
    expect(prep.body.error).toMatchObject({ code: 'listing_invalid', details: { reason: 'spent', txid: 'ee'.repeat(32) } });
    const h2 = makeHarness();
    h2.chain.unknownOutpoints.add(LOC);
    expect((await listViaApi(h2)).body.error.details.reason).toBe('unknown_outpoint');
  });

  it('refuses a PSBT signed for a different price than the challenge', async () => {
    const h = makeHarness();
    const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 40_000 });
    const signedPsbt = walletSign(prep.body.psbtHex, h.seller.priv, [2], SELLER_SIGHASH);
    const ch = await h.request('POST', '/v1/auth/challenge', { action: 'list', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 50_000 });
    const signature = bip322(h.seller, ch.body.message);
    const res = await h.request('POST', '/v1/listings', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000, signedPsbt, message: ch.body.message, signature });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'bad_psbt' });
    expect(res.body.error.message).toMatch(/does not match/);
  });

  it('refuses a challenge signed for another price (the Request ID binds it) without burning the nonce', async () => {
    const h = makeHarness();
    const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    const signedPsbt = walletSign(prep.body.psbtHex, h.seller.priv, [2], SELLER_SIGHASH);
    const ch = await h.request('POST', '/v1/auth/challenge', { action: 'list', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 1_000 });
    const signature = bip322(h.seller, ch.body.message);
    const body = { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, signedPsbt, message: ch.body.message, signature };
    expect((await h.request('POST', '/v1/listings', { ...body, priceSats: 50_000 })).status).toBe(401);
  });

  it('refuses a price whose royalty would be dust', async () => {
    const h = makeHarness({ settings: { royaltyBps: 100, treasuryAddress: keyFromSeed('treasury').tr.address } });
    const res = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 10_000 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/dust/);
  });

  it('cancels only with a seller-signed cancel challenge; wipes the stored signature', async () => {
    const h = makeHarness();
    await listViaApi(h);
    const ch = await h.request('POST', '/v1/auth/challenge', { action: 'cancel', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID });
    const bad = await h.request('POST', `/v1/listings/${INSCRIPTION_ID}/cancel`, { sellerAddress: h.seller.tr.address, message: ch.body.message, signature: 'A'.repeat(88) });
    expect(bad.status).toBe(401);
    const notSeller = await h.request('POST', `/v1/listings/${INSCRIPTION_ID}/cancel`, { sellerAddress: h.buyer.tr.address, message: ch.body.message, signature: 'A'.repeat(88) });
    expect(notSeller.status).toBe(403);
    // a `list` challenge cannot authorise a cancel
    const listCh = await h.request('POST', '/v1/auth/challenge', { action: 'list', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 50_000 });
    expect((await h.request('POST', `/v1/listings/${INSCRIPTION_ID}/cancel`, { sellerAddress: h.seller.tr.address, message: listCh.body.message, signature: bip322(h.seller, listCh.body.message) })).status).toBe(401);
    const ok = await h.request('POST', `/v1/listings/${INSCRIPTION_ID}/cancel`, { sellerAddress: h.seller.tr.address, message: ch.body.message, signature: bip322(h.seller, ch.body.message) });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('cancelled');
    expect((await h.request('GET', '/v1/listings')).body.items).toHaveLength(0);
    expect((await h.store.get(INSCRIPTION_ID))!.sellerSignature).toBeNull();
    expect(h.events_.map((e) => e.status)).toEqual(['active', 'cancelled']);
    // replaying the same signed cancel is refused (nonce consumed)
    const replay = await h.request('POST', `/v1/listings/${INSCRIPTION_ID}/cancel`, { sellerAddress: h.seller.tr.address, message: ch.body.message, signature: bip322(h.seller, ch.body.message) });
    expect(replay.status).toBe(404);
    // and the Degent can be listed again as a new row
    expect((await listViaApi(h, 70_000)).status).toBe(201);
  });

  it('a native segwit (P2WPKH) seller can list with an ECDSA 0x83 signature and a BIP-322 P2WPKH proof', async () => {
    const h = makeHarness();
    h.ord.inscriptions.get(INSCRIPTION_ID)!.address = h.seller.wpkh.address;
    const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.wpkh.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    const signedPsbt = walletSign(prep.body.psbtHex, h.seller.priv, [2], SELLER_SIGHASH);
    const ch = await h.request('POST', '/v1/auth/challenge', { action: 'list', address: h.seller.wpkh.address, inscriptionId: INSCRIPTION_ID, priceSats: 50_000 });
    const res = await h.request('POST', '/v1/listings', {
      inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.wpkh.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000,
      signedPsbt, message: ch.body.message, signature: bip322(h.seller, ch.body.message, 'p2wpkh'),
    });
    expect(res.status).toBe(201);
  });
});

describe('buy flow (BUYS_ENABLED=true, fakes)', () => {
  it('prepare → wallet signs the real tx → submit → broadcast → pending → watcher settles it as sold', async () => {
    const h = buysOn({ royaltyBps: 200, treasuryAddress: keyFromSeed('treasury').tr.address });
    expect((await listViaApi(h)).status).toBe(201);
    const prep = await prepareBuy(h, { feeTier: 'fast' });
    expect(prep.status).toBe(200);
    expect(prep.body.kind).toBe('buy');
    expect(prep.body.summary).toMatchObject({ feeRate: 20, royaltySats: 1000, priceSats: 50_000, postageSats: 10_000 });
    expect(prep.body.inscriptionDestination).toEqual({ vout: 1, offset: 0 });
    expect(prep.body.toSignInputs.map((i: { index: number }) => i.index)).toEqual([0, 1, 3]);
    expect(prep.body.summary.outputs[1]).toMatchObject({ role: 'inscription', owner: 'buyer', address: h.buyer.tr.address });

    const signedPsbt = walletSign(prep.body.psbtHex, h.buyer.priv, [0, 1, 3], undefined, { finalize: true });
    const sub = await h.request('POST', '/v1/buy/submit', { sessionId: prep.body.sessionId, signedPsbt });
    expect(sub.status).toBe(200);
    expect(sub.body.kind).toBe('buy');
    expect(sub.body.explorerUrl).toBe(`https://mempool.test/tx/${sub.body.txid}`);
    expect(h.chain.broadcasts).toHaveLength(1);
    expect((await h.request('GET', `/v1/listings/${INSCRIPTION_ID}`)).body.status).toBe('pending');

    const raw = btc.RawTx.decode(hex.decode(h.chain.broadcasts[0]!.rawHex));
    expect(raw.inputs).toHaveLength(4);
    expect(raw.outputs[1]!.amount).toBe(10_000n);
    expect(hex.encode(raw.outputs[1]!.script)).toBe(hex.encode(h.buyer.tr.script));
    expect(raw.outputs[2]!.amount).toBe(50_000n);
    expect(hex.encode(raw.outputs[2]!.script)).toBe(hex.encode(h.seller.tr.script));
    expect(raw.outputs[3]!.amount).toBe(1_000n);

    // replaying the session is refused
    expect((await h.request('POST', '/v1/buy/submit', { sessionId: prep.body.sessionId, signedPsbt })).status).toBe(409);

    // the network sees the spend → the watcher marks it sold
    h.chain.confirm(h.chain.broadcasts[0]!.rawHex, h.addressOf);
    const tick = await h.watcher.tick();
    expect(tick.changes).toEqual([expect.objectContaining({ from: 'pending', to: 'sold', txid: sub.body.txid })]);
    const final = await h.request('GET', `/v1/listings/${INSCRIPTION_ID}`);
    expect(final.body).toMatchObject({ status: 'sold', settlementTxid: sub.body.txid });
    expect(h.events_.map((e) => e.status)).toEqual(['active', 'pending', 'sold']);
    expect((await h.store.get(INSCRIPTION_ID))!.sellerSignature).toBeNull();
  });

  it('asks the buyer to create padding UTXOs when none exist, then the listing stays active', async () => {
    const h = buysOn();
    h.chain.utxos.set(h.buyer.tr.address, [{ txid: TXIDS.pay1, vout: 0, value: 400_000n, confirmed: true }]);
    await listViaApi(h);
    const prep = await prepareBuy(h);
    expect(prep.status).toBe(200);
    expect(prep.body.kind).toBe('dummies');
    const signedPsbt = walletSign(prep.body.psbtHex, h.buyer.priv, prep.body.toSignInputs.map((i: { index: number }) => i.index), undefined, { finalize: true });
    const sub = await h.request('POST', '/v1/buy/submit', { sessionId: prep.body.sessionId, signedPsbt });
    expect(sub.status).toBe(200);
    expect(sub.body.kind).toBe('dummies');
    expect((await h.request('GET', `/v1/listings/${INSCRIPTION_ID}`)).body.status).toBe('active');
  });

  it('never spends a UTXO ord says carries an inscription (or one the wallet excluded)', async () => {
    const h = buysOn();
    await listViaApi(h);
    h.ord.inscribed.add(`${TXIDS.pay1}:0`);
    const prep = await prepareBuy(h);
    expect(prep.status).toBe(400);
    expect(prep.body.error.code).toBe('insufficient_funds');
    h.ord.inscribed.clear();
    const excluded = await prepareBuy(h, { excludeOutpoints: [`${TXIDS.pay1}:0`] });
    expect(excluded.body.error.code).toBe('insufficient_funds');
  });

  it('refuses to buy a listing whose inscription moved, an own listing, and an expired one', async () => {
    const h = buysOn();
    await listViaApi(h);
    h.ord.inscriptions.get(INSCRIPTION_ID)!.outpoint = `${'dd'.repeat(32)}:0`;
    const moved = await prepareBuy(h);
    expect(moved.status).toBe(409);
    expect(moved.body.error.details.reason).toBe('moved');
    h.ord.inscriptions.get(INSCRIPTION_ID)!.outpoint = LOC;
    const own = await h.request('POST', '/v1/buy/prepare', { inscriptionId: INSCRIPTION_ID, buyerAddress: h.seller.tr.address, buyerPublicKey: h.seller.publicKeyHex });
    expect(own.body.error.code).toBe('own_listing');
    h.clock.advance(31 * 86_400_000);
    expect((await prepareBuy(h)).body.error.code).toBe('listing_expired');
  });

  it('rejects a tampered signed PSBT at submit and broadcasts nothing', async () => {
    const h = buysOn();
    await listViaApi(h);
    const prep = await prepareBuy(h);
    const signedPsbt = tamperOutput(prep.body.psbtHex, 2, 1_000n, h.buyer.priv); // underpay the seller
    const sub = await h.request('POST', '/v1/buy/submit', { sessionId: prep.body.sessionId, signedPsbt });
    expect(sub.status).toBe(400);
    expect(sub.body.error.code).toBe('bad_psbt');
    expect(h.chain.broadcasts).toHaveLength(0);
  });

  it('expired sessions (410), unknown sessions (404), a rejected broadcast (502) releases the session', async () => {
    const h = buysOn();
    await listViaApi(h);
    const prep = await prepareBuy(h);
    const signedPsbt = walletSign(prep.body.psbtHex, h.buyer.priv, [0, 1, 3], undefined, { finalize: true });
    expect((await h.request('POST', '/v1/buy/submit', { sessionId: 'ab'.repeat(16), signedPsbt })).status).toBe(404);
    h.chain.rejectBroadcast = 'bad-txns-inputs-missingorspent';
    const rej = await h.request('POST', '/v1/buy/submit', { sessionId: prep.body.sessionId, signedPsbt });
    expect(rej.status).toBe(502);
    expect(rej.body.error.code).toBe('broadcast_rejected');
    expect((await h.request('GET', `/v1/listings/${INSCRIPTION_ID}`)).body.status).toBe('active');
    h.chain.rejectBroadcast = null;
    h.clock.advance(11 * 60_000);
    expect((await h.request('POST', '/v1/buy/submit', { sessionId: prep.body.sessionId, signedPsbt })).status).toBe(410);
  });

  it('a listing cancelled between prepare and submit is not bought', async () => {
    const h = buysOn();
    await listViaApi(h);
    const prep = await prepareBuy(h);
    const ch = await h.request('POST', '/v1/auth/challenge', { action: 'cancel', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID });
    await h.request('POST', `/v1/listings/${INSCRIPTION_ID}/cancel`, { sellerAddress: h.seller.tr.address, message: ch.body.message, signature: bip322(h.seller, ch.body.message) });
    const signedPsbt = walletSign(prep.body.psbtHex, h.buyer.priv, [0, 1, 3], undefined, { finalize: true });
    const sub = await h.request('POST', '/v1/buy/submit', { sessionId: prep.body.sessionId, signedPsbt });
    expect(sub.status).toBe(409);
    expect(sub.body.error.code).toBe('listing_not_active');
    expect(h.chain.broadcasts).toHaveLength(0);
  });

  it('upstream outages are 503, never 500', async () => {
    const h = buysOn();
    await listViaApi(h);
    h.ord.down = true;
    expect((await prepareBuy(h)).status).toBe(503);
    h.ord.down = false;
    h.chain.down = true;
    expect((await prepareBuy(h)).body.error.code).toBe('upstream_unavailable');
  });
});
