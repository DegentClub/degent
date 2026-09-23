import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { Signer } from 'bip322-js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { keyFromSeed, mockNetwork, walletSign, TXIDS, INSCRIPTION_ID } from './helpers.js';
import { SELLER_SIGHASH } from '../src/psbt/index.js';

const seller = keyFromSeed('seller');
const buyer = keyFromSeed('buyer');

/** Rebuild a PSBT with one output amount changed, then sign the buyer inputs (a malicious client). */
function tamperOutput(psbtHex, outIdx, amount) {
  const src = btc.Transaction.fromPSBT(hex.decode(psbtHex));
  const tx = new btc.Transaction();
  for (let i = 0; i < src.inputsLength; i++) {
    const { txid, index, witnessUtxo, tapInternalKey, sequence } = src.getInput(i);
    tx.addInput({ txid, index, witnessUtxo, tapInternalKey, sequence });
  }
  for (let i = 0; i < src.outputsLength; i++) {
    const { script, amount: a } = src.getOutput(i);
    tx.addOutput({ script, amount: i === outIdx ? amount : a });
  }
  for (let i = 0; i < src.inputsLength; i++) {
    const w = src.getInput(i).finalScriptWitness;
    if (w) tx.updateInput(i, { finalScriptWitness: w }, true);
    else tx.signIdx(buyer.priv, i);
  }
  return hex.encode(tx.toPSBT());
}
const LOC = `${TXIDS.inscription}:1`;
const collection = [{ name: 'Degent #1', inscription_id: INSCRIPTION_ID, inscription_number: 1 }];
const silent = { info() {}, warn() {}, error() {} };

function boot(env = {}, netOpts = {}) {
  const config = loadConfig({ BUYS_ENABLED: 'false', BITCOIN_NETWORK: 'mainnet', ...env });
  const net = mockNetwork({
    inscription: { id: INSCRIPTION_ID, number: 1, address: seller.tr.address, outpoint: LOC, offset: 0, value: 10_000, contentType: 'image/png' },
    utxosByAddress: { [buyer.tr.address]: [{ txid: TXIDS.dummy, vout: 0, value: 600 }, { txid: TXIDS.dummy, vout: 1, value: 700 }, { txid: TXIDS.pay1, vout: 0, value: 400_000 }] },
    ...netOpts,
  });
  const app = createApp({ config, db: openDb(':memory:'), mempool: net.mempool, indexer: net.indexer, collection, logger: silent });
  return { ...app, net, agent: request(app.app) };
}

async function listViaApi(ctx, priceSats = 50_000) {
  const prep = await ctx.agent.post('/api/listings/prepare').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats });
  expect(prep.status).toBe(200);
  expect(prep.body.signIndex).toBe(2);
  const signedPsbt = walletSign(prep.body.psbtHex, seller.priv, [2], SELLER_SIGHASH);
  const ch = await ctx.agent.post('/api/challenge').send({ action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats });
  expect(ch.status).toBe(200);
  const signature = Signer.sign(seller.wif, seller.tr.address, ch.body.message);
  return ctx.agent.post('/api/listings').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats, signedPsbt, nonce: ch.body.nonce, signature });
}

describe('hardening', () => {
  let ctx;
  beforeAll(() => { ctx = boot(); });

  it('serves the site with a strict CSP and no CORS header by default', async () => {
    const res = await ctx.agent.get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does not expose server code or the database', async () => {
    for (const p of ['/market.db', '/src/app.js', '/package.json', '/legacy/psbt-unsafe.js', '/.env', '/tests/api.test.js']) {
      expect((await ctx.agent.get(p)).status).toBe(404);
    }
  });

  it('gates buys behind BUYS_ENABLED with 503', async () => {
    expect((await ctx.agent.post('/api/buy/prepare').send({})).status).toBe(503);
    expect((await ctx.agent.post('/api/buy/submit').send({})).status).toBe(503);
    expect((await ctx.agent.get('/api/health')).body.buysEnabled).toBe(false);
  });

  it('has no GET mutation routes and no sold endpoint', async () => {
    expect((await ctx.agent.get(`/api/listings/${INSCRIPTION_ID}/cancel?seller=x`)).status).toBe(404);
    expect((await ctx.agent.get(`/api/listings/${INSCRIPTION_ID}/sold`)).status).toBe(404);
    expect([403, 404]).toContain((await ctx.agent.get('/api/listings/create?data=e30=')).status);
    expect((await ctx.agent.patch(`/api/listings/${INSCRIPTION_ID}/sold`)).status).toBe(404);
    expect((await ctx.agent.post(`/api/listings/${INSCRIPTION_ID}/sold`)).status).toBe(404);
  });

  it('validates input', async () => {
    const res = await ctx.agent.post('/api/listings/prepare').send({ inscriptionId: 'nope', sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inscriptionId/);
  });

  it('sends the configured CORS origin only', async () => {
    const c = boot({ CORS_ORIGIN: 'https://market.degent.club' });
    const ok = await c.agent.get('/api/health').set('Origin', 'https://market.degent.club');
    expect(ok.headers['access-control-allow-origin']).toBe('https://market.degent.club');
    const no = await c.agent.get('/api/health').set('Origin', 'https://evil.example');
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('listing lifecycle', () => {
  it('creates a listing with a verified seller signature and BIP-322 proof', async () => {
    const ctx = boot();
    const res = await listViaApi(ctx);
    expect(res.status).toBe(201);
    expect(res.body.listing.status).toBe('active');
    expect(res.body.listing.location).toBe(LOC);
    expect(res.body.listing).not.toHaveProperty('sellerSigHex');
    const list = await ctx.agent.get('/api/listings');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Degent #1');
    expect((await ctx.agent.get(`/api/listings/${INSCRIPTION_ID}`)).body.priceSats).toBe(50_000);
    // second listing of the same active inscription is refused
    const again = await ctx.agent.post('/api/listings/prepare').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 60_000 });
    expect(again.status).toBe(409);
  });

  it('refuses a listing without a valid challenge signature', async () => {
    const ctx = boot();
    const prep = await ctx.agent.post('/api/listings/prepare').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 50_000 });
    const signedPsbt = walletSign(prep.body.psbtHex, seller.priv, [2], SELLER_SIGHASH);
    const ch = await ctx.agent.post('/api/challenge').send({ action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 50_000 });
    const impostor = keyFromSeed('impostor');
    const signature = Signer.sign(impostor.wif, impostor.tr.address, ch.body.message);
    const res = await ctx.agent.post('/api/listings').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 50_000, signedPsbt, nonce: ch.body.nonce, signature });
    expect(res.status).toBe(401);
    expect((await ctx.agent.get('/api/listings')).body).toHaveLength(0);
  });

  it('refuses a listing when the seller does not hold the inscription', async () => {
    const ctx = boot();
    ctx.net.state.inscription.address = keyFromSeed('someone').tr.address;
    const prep = await ctx.agent.post('/api/listings/prepare').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 50_000 });
    expect(prep.status).toBe(403);
  });

  it('refuses a listing whose outpoint is already spent', async () => {
    const ctx = boot();
    ctx.net.state.spent.set(LOC, { txid: 'ee'.repeat(32) });
    const prep = await ctx.agent.post('/api/listings/prepare').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 50_000 });
    expect(prep.status).toBe(409);
    expect(prep.body.code).toBe('SPENT');
  });

  it('refuses a PSBT signed for a different price than the challenge', async () => {
    const ctx = boot();
    const prep = await ctx.agent.post('/api/listings/prepare').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 40_000 });
    const signedPsbt = walletSign(prep.body.psbtHex, seller.priv, [2], SELLER_SIGHASH);
    const ch = await ctx.agent.post('/api/challenge').send({ action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 50_000 });
    const signature = Signer.sign(seller.wif, seller.tr.address, ch.body.message);
    const res = await ctx.agent.post('/api/listings').send({ inscriptionId: INSCRIPTION_ID, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 50_000, signedPsbt, nonce: ch.body.nonce, signature });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/);
  });

  it('cancels only with a seller-signed challenge', async () => {
    const ctx = boot();
    await listViaApi(ctx);
    const ch = await ctx.agent.post('/api/challenge').send({ action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID });
    const garbage = 'A'.repeat(88);
    const bad = await ctx.agent.post(`/api/listings/${INSCRIPTION_ID}/cancel`).send({ sellerAddress: seller.tr.address, nonce: ch.body.nonce, signature: garbage });
    expect(bad.status).toBe(401);
    const notSeller = await ctx.agent.post(`/api/listings/${INSCRIPTION_ID}/cancel`).send({ sellerAddress: buyer.tr.address, nonce: ch.body.nonce, signature: garbage });
    expect(notSeller.status).toBe(403);
    const signature = Signer.sign(seller.wif, seller.tr.address, ch.body.message);
    const ok = await ctx.agent.post(`/api/listings/${INSCRIPTION_ID}/cancel`).send({ sellerAddress: seller.tr.address, nonce: ch.body.nonce, signature });
    expect(ok.status).toBe(200);
    expect((await ctx.agent.get('/api/listings')).body).toHaveLength(0);
    expect((await ctx.agent.get(`/api/listings/${INSCRIPTION_ID}`)).body.status).toBe('cancelled');
  });
});

describe('buy flow (BUYS_ENABLED=true, mocked network)', () => {
  it('prepares, accepts a wallet-signed PSBT, broadcasts, and the watcher settles it as sold', async () => {
    const ctx = boot({ BUYS_ENABLED: 'true', ROYALTY_BPS: '200', TREASURY_ADDRESS: keyFromSeed('treasury').tr.address });
    expect((await listViaApi(ctx)).status).toBe(201);

    const prep = await ctx.agent.post('/api/buy/prepare').send({ inscriptionId: INSCRIPTION_ID, buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, feeTier: 'fast' });
    expect(prep.status).toBe(200);
    expect(prep.body.needsDummies).toBe(false);
    expect(prep.body.summary.feeRate).toBe(20);
    expect(prep.body.summary.royaltySats).toBe('1000');
    expect(prep.body.ordinalDestination.outputIndex).toBe(1);
    expect(prep.body.toSignInputs.map((i) => i.index)).toEqual([0, 1, 3]);

    const signedPsbt = walletSign(prep.body.psbtHex, buyer.priv, prep.body.toSignInputs.map((i) => i.index), undefined, { finalize: true });
    const sub = await ctx.agent.post('/api/buy/submit').send({ sessionId: prep.body.sessionId, signedPsbt });
    expect(sub.status).toBe(200);
    expect(sub.body.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.net.state.broadcasts).toHaveLength(1);
    expect((await ctx.agent.get(`/api/listings/${INSCRIPTION_ID}`)).body.status).toBe('pending');

    // Decode what was broadcast and check the ordinal really goes to the buyer.
    const raw = btc.RawTx.decode(hex.decode(ctx.net.state.broadcasts[0].rawHex));
    expect(raw.inputs.length).toBe(4);
    expect(raw.outputs[1].amount).toBe(10_000n);
    expect(hex.encode(raw.outputs[1].script)).toBe(hex.encode(buyer.tr.script));
    expect(raw.outputs[2].amount).toBe(50_000n);
    expect(hex.encode(raw.outputs[2].script)).toBe(hex.encode(seller.tr.script));

    // Replaying the session is refused.
    expect((await ctx.agent.post('/api/buy/submit').send({ sessionId: prep.body.sessionId, signedPsbt })).status).toBe(404);

    // Network sees the spend → watcher marks sold.
    const txid = sub.body.txid;
    ctx.net.state.spent.set(LOC, { txid });
    ctx.net.state.txs.set(txid, { vout: raw.outputs.map((o) => ({ scriptpubkey_address: hex.encode(o.script) === hex.encode(seller.tr.script) ? seller.tr.address : buyer.tr.address, value: Number(o.amount) })) });
    await ctx.watcher.tick();
    const final = await ctx.agent.get(`/api/listings/${INSCRIPTION_ID}`);
    expect(final.body.status).toBe('sold');
    expect(final.body.settlementTxid).toBe(txid);
  });

  it('asks the buyer to create dummy UTXOs when none exist', async () => {
    const ctx = boot({ BUYS_ENABLED: 'true' }, { utxosByAddress: { [buyer.tr.address]: [{ txid: TXIDS.pay1, vout: 0, value: 400_000 }] } });
    await listViaApi(ctx);
    const prep = await ctx.agent.post('/api/buy/prepare').send({ inscriptionId: INSCRIPTION_ID, buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex });
    expect(prep.status).toBe(200);
    expect(prep.body.needsDummies).toBe(true);
    const signedPsbt = walletSign(prep.body.psbtHex, buyer.priv, prep.body.toSignInputs.map((i) => i.index), undefined, { finalize: true });
    const sub = await ctx.agent.post('/api/buy/submit').send({ sessionId: prep.body.sessionId, signedPsbt });
    expect(sub.status).toBe(200);
    expect(sub.body.kind).toBe('dummies');
    expect((await ctx.agent.get(`/api/listings/${INSCRIPTION_ID}`)).body.status).toBe('active');
  });

  it('never spends a UTXO the indexer says carries an inscription', async () => {
    const ctx = boot({ BUYS_ENABLED: 'true' });
    await listViaApi(ctx);
    ctx.net.state.inscribedOutpoints.add(`${TXIDS.pay1}:0`);
    const prep = await ctx.agent.post('/api/buy/prepare').send({ inscriptionId: INSCRIPTION_ID, buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex });
    expect(prep.status).toBe(400);
    expect(prep.body.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('refuses to buy a listing whose inscription moved', async () => {
    const ctx = boot({ BUYS_ENABLED: 'true' });
    await listViaApi(ctx);
    ctx.net.state.inscription.outpoint = 'dd'.repeat(32) + ':0';
    const prep = await ctx.agent.post('/api/buy/prepare').send({ inscriptionId: INSCRIPTION_ID, buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex });
    expect(prep.status).toBe(409);
    expect(prep.body.code).toBe('MOVED');
  });

  it('rejects a tampered signed PSBT at submit', async () => {
    const ctx = boot({ BUYS_ENABLED: 'true' });
    await listViaApi(ctx);
    const prep = await ctx.agent.post('/api/buy/prepare').send({ inscriptionId: INSCRIPTION_ID, buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex });
    const signedPsbt = tamperOutput(prep.body.psbtHex, 2, 1_000n); // try to underpay the seller
    const sub = await ctx.agent.post('/api/buy/submit').send({ sessionId: prep.body.sessionId, signedPsbt });
    expect(sub.status).toBe(400);
    expect(ctx.net.state.broadcasts).toHaveLength(0);
  });
});
