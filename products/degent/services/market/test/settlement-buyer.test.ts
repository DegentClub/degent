import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { inscriptionDestination } from '@bsh/inscription';
import { INSCRIPTION_INPUT_INDEX, INSCRIPTION_OUTPUT_INDEX, estimateVsize, royaltyFor } from '@bsh/degent-market-sdk';
import {
  SELLER_SIGHASH,
  assembleBuyerSigned,
  buildBuyerPsbt,
  buildDummySplitPsbt,
  buildSellerTemplate,
  extractSellerSignature,
  satShape,
  verifyInputSignature,
  type BuildBuyerArgs,
} from '../src/domain/settlement/index.js';
import { NET, TXIDS, keyFromSeed, walletSign, type TestKey } from './fakes/keys.js';

const seller = keyFromSeed('seller');
const buyer = keyFromSeed('buyer');
const treasury = keyFromSeed('treasury');
const inscriptionUtxo = { txid: TXIDS.inscription, vout: 1, value: 10_000 };
const PRICE = 250_000;
const dummies = [{ txid: TXIDS.dummy, vout: 0, value: 600 }, { txid: TXIDS.dummy, vout: 1, value: 600 }];
const payments = [{ txid: TXIDS.pay1, vout: 0, value: 300_000 }, { txid: TXIDS.pay2, vout: 3, value: 120_000 }, { txid: TXIDS.pay3, vout: 0, value: 50_000 }];

function sellerSig(priceSats = PRICE, who: TestKey = seller) {
  const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: who.tr.address, sellerPublicKey: who.publicKeyHex, priceSats, network: NET });
  return extractSellerSignature(walletSign(t.psbtHex, who.priv, [INSCRIPTION_INPUT_INDEX], SELLER_SIGHASH));
}

function args(over: Partial<BuildBuyerArgs> = {}, priceSats = PRICE, sig = sellerSig(priceSats)): BuildBuyerArgs {
  return {
    listing: { inscriptionUtxo, satOffset: 0, sellerAddress: seller.tr.address, priceSats, sellerSignature: sig },
    buyerAddress: buyer.tr.address,
    buyerPublicKey: buyer.publicKeyHex,
    dummyUtxos: dummies,
    paymentUtxos: payments,
    feeRate: 5,
    network: NET,
    ...over,
  };
}

describe('buildBuyerPsbt', () => {
  it('lays out [pad, pad, inscription, payment…] → [merge, postage, price, royalty, change]', () => {
    const res = buildBuyerPsbt(args({ feeRate: 10, royaltyBps: 250, treasuryAddress: treasury.tr.address }));
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    expect(tx.inputsLength).toBe(4);
    expect([0, 1, 2, 3].map((i) => hex.encode(tx.getInput(i).txid!))).toEqual([TXIDS.dummy, TXIDS.dummy, TXIDS.inscription, TXIDS.pay1]);
    expect(tx.getInput(2).finalScriptWitness!.length).toBe(1);
    expect(hex.encode(tx.getInput(0).tapInternalKey!)).toBe(buyer.publicKeyHex.slice(2));
    expect(tx.outputsLength).toBe(5);
    const out = (i: number) => tx.getOutput(i);
    expect(out(0).amount).toBe(1_200n);
    expect(hex.encode(out(0).script!)).toBe(hex.encode(buyer.tr.script));
    expect(out(1).amount).toBe(10_000n);
    expect(hex.encode(out(1).script!)).toBe(hex.encode(buyer.tr.script));
    expect(out(2).amount).toBe(BigInt(PRICE));
    expect(hex.encode(out(2).script!)).toBe(hex.encode(seller.tr.script));
    expect(out(3).amount).toBe(royaltyFor(PRICE, 250));
    expect(out(3).amount).toBe(6_250n);
    expect(hex.encode(out(3).script!)).toBe(hex.encode(treasury.tr.script));
    expect(hex.encode(out(4).script!)).toBe(hex.encode(buyer.tr.script));
    expect(res.buyerInputIndexes).toEqual([0, 1, 3]);
    expect(res.destination).toEqual({ vout: INSCRIPTION_OUTPUT_INDEX, offset: 0n });
    expect(res.summary.totalBuyerCostSats).toBe(PRICE + 6_250 + res.summary.feeSats);
    // the summary is the real transaction, role by role
    expect(res.summary.outputs.map((o) => `${o.index}:${o.role}:${o.owner}`)).toEqual(['0:dummy_merge:buyer', '1:inscription:buyer', '2:price:seller', '3:royalty:treasury', '4:change:buyer']);
    expect(res.summary.inputs.map((i) => `${i.index}:${i.role}:${i.buyerSigns}`)).toEqual(['0:dummy:true', '1:dummy:true', '2:inscription:false', '3:payment:true']);
  });

  it('property: independent FIFO check agrees for random prices, postages, offsets and padding values', () => {
    let seed = 1;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let k = 0; k < 12; k++) {
      const postage = 330 + Math.floor(r() * 20_000);
      const offset = Math.floor(r() * postage);
      const price = 40_000 + Math.floor(r() * 200_000);
      const utxo = { txid: TXIDS.inscription, vout: 1, value: postage };
      const t = buildSellerTemplate({ inscriptionUtxo: utxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: price, network: NET });
      const sig = extractSellerSignature(walletSign(t.psbtHex, seller.priv, [2], SELLER_SIGHASH));
      const pads = [{ txid: TXIDS.dummy, vout: 0, value: 600 + Math.floor(r() * 400) }, { txid: TXIDS.dummy, vout: 1, value: 600 + Math.floor(r() * 400) }];
      const res = buildBuyerPsbt({ ...args(), listing: { inscriptionUtxo: utxo, satOffset: offset, sellerAddress: seller.tr.address, priceSats: price, sellerSignature: sig }, dummyUtxos: pads, royaltyBps: k % 3 === 0 ? 0 : 100 + Math.floor(r() * 400), treasuryAddress: treasury.tr.address });
      const shape = satShape(btc.Transaction.fromPSBT(hex.decode(res.psbtHex)));
      expect(inscriptionDestination(shape, 2, offset)).toEqual({ vout: 1, offset: BigInt(offset) });
    }
  });

  it('charges a fee within tolerance of the real signed vsize × feeRate', () => {
    for (const feeRate of [1, 7, 42]) {
      const res = buildBuyerPsbt(args({ feeRate }));
      const signed = walletSign(res.psbtHex, buyer.priv, res.buyerInputIndexes, undefined, { finalize: true });
      const { vsize, fee } = assembleBuyerSigned({ sessionPsbt: res.psbtHex, signedPsbt: signed, buyerInputIndexes: res.buyerInputIndexes });
      const effective = Number(fee) / vsize;
      expect(effective).toBeGreaterThanOrEqual(feeRate);
      expect(effective).toBeLessThanOrEqual(feeRate * 1.08 + 1);
      expect(Math.abs(res.summary.vsize - vsize)).toBeLessThanOrEqual(6);
    }
  });

  it('selects multiple payment UTXOs when one is not enough', () => {
    const res = buildBuyerPsbt(args({}, 400_000));
    expect(res.summary.inputs.filter((i) => i.role === 'payment')).toHaveLength(2);
    expect(res.buyerInputIndexes).toEqual([0, 1, 3, 4]);
    expect(res.destination.vout).toBe(1);
  });

  it('drops the change output when it would be dust and lets the remainder go to fee', () => {
    const res = buildBuyerPsbt(args({ feeRate: 1, paymentUtxos: [{ txid: TXIDS.pay1, vout: 0, value: 300_000 }] }, 299_500));
    expect(res.summary.changeSats).toBe(0);
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    expect(tx.outputsLength).toBe(3);
    expect(tx.fee).toBe(500n);
    expect(res.destination.vout).toBe(1);
  });

  it('fails with insufficient_funds rather than producing an invalid tx', () => {
    expect(() => buildBuyerPsbt(args({ paymentUtxos: [{ txid: TXIDS.pay3, vout: 0, value: 50_000 }] }))).toThrow(expect.objectContaining({ code: 'insufficient_funds' }));
  });

  it('requires exactly two padding UTXOs of at least 600 sats', () => {
    expect(() => buildBuyerPsbt(args({ dummyUtxos: [dummies[0]!] }))).toThrow(expect.objectContaining({ code: 'need_dummies' }));
    expect(() => buildBuyerPsbt(args({ dummyUtxos: [dummies[0]!, { ...dummies[1]!, value: 500 }] }))).toThrow(expect.objectContaining({ code: 'need_dummies' }));
  });

  it('refuses when the seller signature does not match the price (listing claims less than signed)', () => {
    expect(() => buildBuyerPsbt(args({}, PRICE - 1, sellerSig(PRICE)))).toThrow(expect.objectContaining({ code: 'bad_seller_signature' }));
  });

  it('refuses a signature from a different key', () => {
    expect(() => buildBuyerPsbt(args({}, PRICE, sellerSig(PRICE, keyFromSeed('impostor'))))).toThrow(expect.objectContaining({ code: 'bad_seller_signature' }));
  });

  it('never spends the inscription outpoint or a padding UTXO as payment', () => {
    const res = buildBuyerPsbt(args({ paymentUtxos: [...payments, { txid: TXIDS.inscription, vout: 1, value: 10_000 }, dummies[0]!] }));
    const payIns = res.summary.inputs.filter((i) => i.role === 'payment').map((i) => i.outpoint);
    expect(payIns).not.toContain(`${TXIDS.inscription}:1`);
    expect(payIns).not.toContain(`${TXIDS.dummy}:0`);
  });

  it('a seller cannot be paid less: FIFO and signature both guard output 2', () => {
    const sig = sellerSig();
    const res = buildBuyerPsbt(args({}, PRICE, sig));
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    expect(inscriptionDestination(satShape(tx), INSCRIPTION_INPUT_INDEX, 0)).toEqual({ vout: 1, offset: 0n });
    expect(verifyInputSignature(tx, INSCRIPTION_INPUT_INDEX, sig)).toBe(true);
    // the same signature on a transaction paying 1 sat less at output 2 is invalid
    const cheaper = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    const t2 = new btc.Transaction({ allowUnknownOutputs: true });
    for (let i = 0; i < cheaper.inputsLength; i++) {
      const inp = cheaper.getInput(i);
      t2.addInput({ txid: inp.txid!, index: inp.index!, witnessUtxo: inp.witnessUtxo!, sequence: inp.sequence! });
    }
    for (let i = 0; i < cheaper.outputsLength; i++) t2.addOutput({ script: cheaper.getOutput(i).script!, amount: i === 2 ? BigInt(PRICE - 1) : cheaper.getOutput(i).amount! });
    expect(verifyInputSignature(t2, INSCRIPTION_INPUT_INDEX, sig)).toBe(false);
  });

  it('royalty: required treasury, below-dust refused, 0 bps omits the output', () => {
    expect(() => buildBuyerPsbt(args({ royaltyBps: 100 }))).toThrow(/treasury/);
    expect(() => buildBuyerPsbt(args({ royaltyBps: 1, treasuryAddress: treasury.tr.address }, 10_000, sellerSig(10_000)))).toThrow(/dust/);
    const res = buildBuyerPsbt(args({ royaltyBps: 0, treasuryAddress: treasury.tr.address }));
    expect(res.summary.outputs.some((o) => o.role === 'royalty')).toBe(false);
    expect(res.summary.royaltySats).toBe(0);
  });
});

describe('buildDummySplitPsbt', () => {
  it('creates two 600-sat outputs plus change from the buyer funds, at the requested rate', () => {
    const res = buildDummySplitPsbt({ buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, paymentUtxos: payments, feeRate: 3, network: NET });
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    expect(tx.outputsLength).toBe(3);
    expect(tx.getOutput(0).amount).toBe(600n);
    expect(tx.getOutput(1).amount).toBe(600n);
    expect(Number(tx.fee) / estimateVsize(['tr'], ['tr', 'tr', 'tr'])).toBeGreaterThanOrEqual(3);
    expect(res.summary.outputs.map((o) => o.role)).toEqual(['dummy', 'dummy', 'change']);
  });

  it('refuses when the buyer cannot fund it', () => {
    expect(() => buildDummySplitPsbt({ buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, paymentUtxos: [{ txid: TXIDS.pay1, vout: 0, value: 1_000 }], feeRate: 3, network: NET })).toThrow(
      expect.objectContaining({ code: 'insufficient_funds' }),
    );
  });
});
