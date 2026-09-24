/**
 * End to end through the typed SDK client (@bsh/degent-market-sdk) against the real app on fakes:
 * the client, the contract and the service agree; the buyer sees the real transaction; the
 * inscription reaches the buyer's postage output on chain (by @bsh/inscription's FIFO rule).
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { inscriptionDestination } from '@bsh/inscription';
import { ApiError, buyerCost, createMarketClient, royaltyFor } from '@bsh/degent-market-sdk';
import { SELLER_SIGHASH } from '../src/domain/settlement/index.js';
import { bip322, makeHarness } from './fakes/harness.js';
import { INSCRIPTION_ID, keyFromSeed, walletSign } from './fakes/keys.js';

describe('marketplace end to end via the SDK client', () => {
  it('paused → list → enable buys → buy → sold, with the inscription in the buyer output', async () => {
    const treasury = keyFromSeed('treasury');
    const h = makeHarness({ settings: { royaltyBps: 250, treasuryAddress: treasury.tr.address } });
    const client = createMarketClient({ baseUrl: 'http://market.test', fetch: (url, init) => Promise.resolve(h.app.request(url, init)) });

    // paused banner data
    const cfg = await client.config();
    expect(cfg.buysEnabled).toBe(false);
    await expect(client.buyPrepare({ inscriptionId: INSCRIPTION_ID, buyerAddress: h.buyer.tr.address, buyerPublicKey: h.buyer.publicKeyHex })).rejects.toMatchObject({ status: 503, code: 'buys_paused' });

    // list
    const priceSats = 80_000;
    const prep = await client.prepareListing({ inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats });
    const signedPsbt = walletSign(prep.psbtHex, h.seller.priv, [prep.signIndex], SELLER_SIGHASH);
    const ch = await client.challenge({ action: 'list', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats });
    const { listing } = await client.createListing({ inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats, signedPsbt, message: ch.message, signature: bip322(h.seller, ch.message) });
    expect(listing).toMatchObject({ status: 'active', priceSats, royaltySats: Number(royaltyFor(priceSats, 250)) });

    // the owner flips the kill switch (after signet trades + review)
    h.settings.buysEnabled = true;
    const buy = await client.buyPrepare({ inscriptionId: INSCRIPTION_ID, buyerAddress: h.buyer.tr.address, buyerPublicKey: h.buyer.publicKeyHex, feeTier: 'economy' });
    if (buy.kind !== 'buy') throw new Error('expected a buy');
    // what the UI shows is the PSBT itself: every output, owner and value
    const tx = btc.Transaction.fromPSBT(hex.decode(buy.psbtHex));
    expect(buy.summary.outputs.map((o) => [o.index, o.value])).toEqual(Array.from({ length: tx.outputsLength }, (_, i) => [i, Number(tx.getOutput(i).amount)]));
    expect(buy.summary.totalBuyerCostSats).toBe(Number(buyerCost(priceSats, royaltyFor(priceSats, 250), buy.summary.feeSats)));
    const signed = walletSign(buy.psbtHex, h.buyer.priv, buy.toSignInputs.map((i) => i.index), undefined, { finalize: true });
    const res = await client.buySubmit({ sessionId: buy.sessionId, signedPsbt: Buffer.from(hex.decode(signed)).toString('base64') });
    expect(res.kind).toBe('buy');

    // chain: independently re-derive where the inscription went in the broadcast bytes
    const raw = btc.RawTx.decode(hex.decode(h.chain.broadcasts[0]!.rawHex));
    const values = buy.summary.inputs.map((i) => ({ value: i.value }));
    expect(inscriptionDestination({ inputs: values, outputs: raw.outputs.map((o) => ({ value: o.amount })) }, 2, 0)).toEqual({ vout: 1, offset: 0n });
    expect(hex.encode(raw.outputs[1]!.script)).toBe(hex.encode(h.buyer.tr.script));

    h.chain.confirm(h.chain.broadcasts[0]!.rawHex, h.addressOf);
    await h.watcher.tick();
    expect(await client.listing(INSCRIPTION_ID)).toMatchObject({ status: 'sold', settlementTxid: res.txid });
    expect((await client.listings()).total).toBe(0);
    await expect(client.listing(`${'0'.repeat(64)}i0`)).rejects.toBeInstanceOf(ApiError);
  });
});
