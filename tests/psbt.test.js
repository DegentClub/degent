import { describe, it, expect } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import {
  buildSellerPsbt, extractSellerSignature, buildBuyerPsbt, buildDummySplitPsbt, assembleBuyerSignedPsbt,
  verifyInputSignature, estimateVsize, royaltyFor, computeOrdinalDestination,
  INSCRIPTION_INPUT_INDEX, PRICE_OUTPUT_INDEX, INSCRIPTION_OUTPUT_INDEX, SELLER_SIGHASH,
} from '../src/psbt/index.js';
import { keyFromSeed, TXIDS, walletSign } from './helpers.js';

const NET = btc.NETWORK;
const seller = keyFromSeed('seller');
const buyer = keyFromSeed('buyer');
const treasury = keyFromSeed('treasury');

const inscriptionUtxo = { txid: TXIDS.inscription, vout: 1, value: 10_000 };
const PRICE = 250_000;

function sellerSigned(priceSats = PRICE, who = seller) {
  const built = buildSellerPsbt({ inscriptionUtxo, sellerAddress: who.tr.address, sellerPublicKey: who.publicKeyHex, priceSats, network: NET });
  const signedHex = walletSign(built.psbtHex, who.priv, [INSCRIPTION_INPUT_INDEX], SELLER_SIGHASH);
  const sig = extractSellerSignature(signedHex, { unsignedTxHex: built.unsignedTxHex, inscriptionUtxo, sellerAddress: who.tr.address, priceSats, network: NET });
  return { built, signedHex, sig };
}

function listingFor(sig, priceSats = PRICE) {
  return { inscriptionUtxo, satOffset: 0, sellerAddress: seller.tr.address, priceSats, sellerSignature: sig };
}

const dummies = [{ txid: TXIDS.dummy, vout: 0, value: 600 }, { txid: TXIDS.dummy, vout: 1, value: 600 }];
const payments = [{ txid: TXIDS.pay1, vout: 0, value: 300_000 }, { txid: TXIDS.pay2, vout: 3, value: 120_000 }, { txid: TXIDS.pay3, vout: 0, value: 50_000 }];

describe('buildSellerPsbt', () => {
  it('produces a 3-input / 3-output template with the inscription at index 2 and the price at output 2', () => {
    const { built } = sellerSigned();
    const tx = btc.Transaction.fromPSBT(hex.decode(built.psbtHex), { allowUnknownInputs: true });
    expect(built.signIndex).toBe(2);
    expect(built.sighashType).toBe(0x83);
    expect(tx.inputsLength).toBe(3);
    expect(tx.outputsLength).toBe(3);
    const insc = tx.getInput(2);
    expect(hex.encode(insc.txid)).toBe(TXIDS.inscription);
    expect(insc.index).toBe(1);
    expect(insc.sighashType).toBe(SELLER_SIGHASH);
    expect(insc.witnessUtxo.amount).toBe(10_000n);
    // tapInternalKey must be the UNTWEAKED x-only key, not the address program
    expect(hex.encode(insc.tapInternalKey)).toBe(seller.publicKeyHex.slice(2));
    expect(hex.encode(insc.tapInternalKey)).not.toBe(hex.encode(seller.tr.tweakedPubkey));
    const out = tx.getOutput(PRICE_OUTPUT_INDEX);
    expect(out.amount).toBe(BigInt(PRICE));
    expect(hex.encode(out.script)).toBe(hex.encode(seller.tr.script));
    // placeholders are zero-txid and unsigned
    expect(hex.encode(tx.getInput(0).txid)).toBe('00'.repeat(32));
    expect(tx.getInput(0).sighashType).toBeUndefined();
  });

  it('rejects a public key that does not derive the address', () => {
    expect(() => buildSellerPsbt({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: buyer.publicKeyHex, priceSats: PRICE, network: NET }))
      .toThrow(/does not derive/);
  });

  it('extracts a 65-byte Schnorr signature ending in 0x83', () => {
    const { sig } = sellerSigned();
    expect(sig.kind).toBe('schnorr');
    expect(sig.signatureHex.length).toBe(130);
    expect(sig.signatureHex.slice(-2)).toBe('83');
  });

  it('rejects a signature made with the wrong sighash', () => {
    const built = buildSellerPsbt({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    // Sign with DEFAULT sighash by clearing the sighashType hint.
    const tx = btc.Transaction.fromPSBT(hex.decode(built.psbtHex), { allowUnknownInputs: true });
    tx.updateInput(2, { sighashType: 0x00 });
    tx.signIdx(seller.priv, 2);
    expect(() => extractSellerSignature(hex.encode(tx.toPSBT()))).toThrow(/65-byte|sighash/i);
  });

  it('rejects a signed PSBT whose transaction differs from the template', () => {
    const { built } = sellerSigned();
    const other = buildSellerPsbt({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE - 1, network: NET });
    const signedOther = walletSign(other.psbtHex, seller.priv, [2], SELLER_SIGHASH);
    expect(() => extractSellerSignature(signedOther, { unsignedTxHex: built.unsignedTxHex, inscriptionUtxo, sellerAddress: seller.tr.address, priceSats: PRICE, network: NET }))
      .toThrow(/does not match/);
  });

  it('supports a native segwit (P2WPKH) seller with an ECDSA signature', () => {
    const built = buildSellerPsbt({ inscriptionUtxo, sellerAddress: seller.wpkh.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    const signed = walletSign(built.psbtHex, seller.priv, [2], SELLER_SIGHASH);
    const sig = extractSellerSignature(signed, { unsignedTxHex: built.unsignedTxHex, inscriptionUtxo, sellerAddress: seller.wpkh.address, priceSats: PRICE, network: NET });
    expect(sig.kind).toBe('ecdsa');
    expect(sig.publicKeyHex).toBe(seller.publicKeyHex);
    const listing = { inscriptionUtxo, satOffset: 0, sellerAddress: seller.wpkh.address, priceSats: PRICE, sellerSignature: sig };
    const res = buildBuyerPsbt({ listing, buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET });
    expect(res.ordinalDestination.outputIndex).toBe(1);
  });
});

describe('buildBuyerPsbt', () => {
  it('lays out [dummy, dummy, inscription, payment...] / [merge, postage, price, royalty, change]', () => {
    const { sig } = sellerSigned();
    const res = buildBuyerPsbt({
      listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex,
      dummyUtxos: dummies, paymentUtxos: payments, feeRate: 10, royaltyBps: 250, treasuryAddress: treasury.tr.address, network: NET,
    });
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    expect(tx.inputsLength).toBe(4); // 300k covers price+royalty+fee
    expect(hex.encode(tx.getInput(0).txid)).toBe(TXIDS.dummy);
    expect(hex.encode(tx.getInput(1).txid)).toBe(TXIDS.dummy);
    expect(hex.encode(tx.getInput(2).txid)).toBe(TXIDS.inscription);
    expect(hex.encode(tx.getInput(3).txid)).toBe(TXIDS.pay1);
    // seller's witness pre-attached; buyer inputs carry the untweaked internal key
    expect(tx.getInput(2).finalScriptWitness.length).toBe(1);
    expect(hex.encode(tx.getInput(0).tapInternalKey)).toBe(buyer.publicKeyHex.slice(2));

    expect(tx.outputsLength).toBe(5);
    expect(tx.getOutput(0).amount).toBe(1200n);
    expect(hex.encode(tx.getOutput(0).script)).toBe(hex.encode(buyer.tr.script));
    expect(tx.getOutput(1).amount).toBe(10_000n);
    expect(hex.encode(tx.getOutput(1).script)).toBe(hex.encode(buyer.tr.script));
    expect(tx.getOutput(2).amount).toBe(BigInt(PRICE));
    expect(hex.encode(tx.getOutput(2).script)).toBe(hex.encode(seller.tr.script));
    expect(tx.getOutput(3).amount).toBe(royaltyFor(PRICE, 250));
    expect(tx.getOutput(3).amount).toBe(6_250n);
    expect(hex.encode(tx.getOutput(3).script)).toBe(hex.encode(treasury.tr.script));
    expect(hex.encode(tx.getOutput(4).script)).toBe(hex.encode(buyer.tr.script));

    expect(res.toSignInputs.map((i) => i.index)).toEqual([0, 1, 3]);
    expect(res.ordinalDestination.outputIndex).toBe(INSCRIPTION_OUTPUT_INDEX);
    expect(BigInt(res.summary.totalBuyerCost)).toBe(BigInt(PRICE) + 6_250n + BigInt(res.summary.feeSats));
  });

  it('charges a fee within tolerance of the real signed vsize × feeRate', () => {
    const { sig } = sellerSigned();
    for (const feeRate of [1, 7, 42]) {
      const res = buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate, network: NET });
      const signed = walletSign(res.psbtHex, buyer.priv, res.buyerInputIndexes, undefined, { finalize: true });
      const { vsize, fee } = assembleBuyerSignedPsbt({ sessionPsbtHex: res.psbtHex, signedPsbtHex: signed, buyerInputIndexes: res.buyerInputIndexes });
      const effective = Number(fee) / vsize;
      expect(effective).toBeGreaterThanOrEqual(feeRate);      // never underpays
      expect(effective).toBeLessThanOrEqual(feeRate * 1.08 + 1); // within ~8% (estimate uses worst-case sig sizes)
      expect(Math.abs(res.summary.estimatedVsize - vsize)).toBeLessThanOrEqual(6);
    }
  });

  it('selects multiple payment UTXOs when one is not enough', () => {
    const { sig } = sellerSigned(400_000);
    const res = buildBuyerPsbt({ listing: listingFor(sig, 400_000), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET });
    expect(res.summary.paymentInputs.length).toBe(2);
    expect(res.toSignInputs.map((i) => i.index)).toEqual([0, 1, 3, 4]);
    expect(res.ordinalDestination.outputIndex).toBe(1);
  });

  it('drops the change output when it would be dust and lets the remainder go to fee', () => {
    const { sig } = sellerSigned(299_500);
    const res = buildBuyerPsbt({ listing: listingFor(sig, 299_500), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: [{ txid: TXIDS.pay1, vout: 0, value: 300_000 }], feeRate: 1, network: NET });
    expect(res.summary.changeSats).toBe('0');
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    expect(tx.outputsLength).toBe(3);
    expect(tx.fee).toBe(500n); // 500 leftover < dust(330)+fee → all to miner
    expect(res.ordinalDestination.outputIndex).toBe(1);
  });

  it('fails with INSUFFICIENT_FUNDS rather than producing an invalid tx', () => {
    const { sig } = sellerSigned();
    expect(() => buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: [{ txid: TXIDS.pay3, vout: 0, value: 50_000 }], feeRate: 5, network: NET }))
      .toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
  });

  it('requires exactly two dummy UTXOs of at least 600 sats', () => {
    const { sig } = sellerSigned();
    const args = { listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, paymentUtxos: payments, feeRate: 5, network: NET };
    expect(() => buildBuyerPsbt({ ...args, dummyUtxos: [dummies[0]] })).toThrow(expect.objectContaining({ code: 'NEED_DUMMIES' }));
    expect(() => buildBuyerPsbt({ ...args, dummyUtxos: [dummies[0], { ...dummies[1], value: 500 }] })).toThrow(expect.objectContaining({ code: 'NEED_DUMMIES' }));
  });

  it('refuses to build when the seller signature does not match the price', () => {
    const { sig } = sellerSigned(PRICE);
    // Listing claims a lower price than what the seller actually signed.
    expect(() => buildBuyerPsbt({ listing: listingFor(sig, PRICE - 1), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET }))
      .toThrow(expect.objectContaining({ code: 'BAD_SELLER_SIG' }));
  });

  it('refuses a signature from a different key', () => {
    const { sig } = sellerSigned(PRICE, keyFromSeed('impostor'));
    expect(() => buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET }))
      .toThrow(expect.objectContaining({ code: 'BAD_SELLER_SIG' }));
  });

  it('never spends the inscription outpoint or a dummy as payment', () => {
    const { sig } = sellerSigned();
    const res = buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: [...payments, { txid: TXIDS.inscription, vout: 1, value: 10_000 }, dummies[0]], feeRate: 5, network: NET });
    expect(res.summary.paymentInputs).not.toContain(`${TXIDS.inscription}:1`);
    expect(res.summary.paymentInputs).not.toContain(`${TXIDS.dummy}:0`);
  });

  it('a seller cannot be paid less: the FIFO invariant and signature check both guard output 2', () => {
    const { sig } = sellerSigned();
    const res = buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET });
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    const ins = []; for (let i = 0; i < tx.inputsLength; i++) ins.push({ value: tx.getInput(i).witnessUtxo.amount });
    const outs = []; for (let i = 0; i < tx.outputsLength; i++) outs.push({ value: tx.getOutput(i).amount });
    expect(computeOrdinalDestination(ins, outs, INSCRIPTION_INPUT_INDEX, 0).outputIndex).toBe(1);
    expect(verifyInputSignature(tx, INSCRIPTION_INPUT_INDEX, sig)).toBe(true);
  });
});

describe('assembleBuyerSignedPsbt', () => {
  it('merges wallet signatures and yields a fully-final raw transaction', () => {
    const { sig } = sellerSigned();
    const res = buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET });
    const signed = walletSign(res.psbtHex, buyer.priv, res.buyerInputIndexes, undefined, { finalize: true });
    const out = assembleBuyerSignedPsbt({ sessionPsbtHex: res.psbtHex, signedPsbtHex: signed, buyerInputIndexes: res.buyerInputIndexes });
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);
    const raw = btc.RawTx.decode(hex.decode(out.rawTxHex));
    expect(raw.inputs.length).toBe(4);
    expect(raw.witnesses[2].length).toBe(1);
    expect(raw.witnesses[2][0].length).toBe(65);
    expect(raw.witnesses[0][0].length).toBe(64); // buyer: SIGHASH_DEFAULT
  });

  it('accepts partial (unfinalized) wallet signatures', () => {
    const { sig } = sellerSigned();
    const res = buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET });
    const signed = walletSign(res.psbtHex, buyer.priv, res.buyerInputIndexes, undefined, { finalize: false });
    expect(() => assembleBuyerSignedPsbt({ sessionPsbtHex: res.psbtHex, signedPsbtHex: signed, buyerInputIndexes: res.buyerInputIndexes })).not.toThrow();
  });

  it('rejects a wallet response whose transaction was altered', () => {
    const { sig } = sellerSigned();
    const res = buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET });
    // A malicious client rebuilds the tx with a bigger change output and signs that instead.
    const src = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    const tampered = new btc.Transaction();
    for (let i = 0; i < src.inputsLength; i++) {
      const { txid, index, witnessUtxo, tapInternalKey, sequence } = src.getInput(i);
      tampered.addInput({ txid, index, witnessUtxo, tapInternalKey, sequence });
    }
    for (let i = 0; i < src.outputsLength; i++) {
      const { script, amount } = src.getOutput(i);
      tampered.addOutput({ script, amount: i === 3 ? amount + 1n : amount });
    }
    tampered.updateInput(2, { finalScriptWitness: src.getInput(2).finalScriptWitness }, true);
    for (const i of res.buyerInputIndexes) tampered.signIdx(buyer.priv, i);
    expect(() => assembleBuyerSignedPsbt({ sessionPsbtHex: res.psbtHex, signedPsbtHex: hex.encode(tampered.toPSBT()), buyerInputIndexes: res.buyerInputIndexes }))
      .toThrow(/does not match/);
  });

  it('rejects when an input the buyer had to sign is missing a signature', () => {
    const { sig } = sellerSigned();
    const res = buildBuyerPsbt({ listing: listingFor(sig), buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET });
    const signed = walletSign(res.psbtHex, buyer.priv, [0, 1], undefined);
    expect(() => assembleBuyerSignedPsbt({ sessionPsbtHex: res.psbtHex, signedPsbtHex: signed, buyerInputIndexes: res.buyerInputIndexes })).toThrow(/not signed/);
  });
});

describe('buildDummySplitPsbt', () => {
  it('creates two 600-sat outputs plus change from the buyer funds', () => {
    const res = buildDummySplitPsbt({ buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, paymentUtxos: payments, feeRate: 3, network: NET });
    const tx = btc.Transaction.fromPSBT(hex.decode(res.psbtHex));
    expect(tx.outputsLength).toBe(3);
    expect(tx.getOutput(0).amount).toBe(600n);
    expect(tx.getOutput(1).amount).toBe(600n);
    expect(Number(tx.fee) / estimateVsize([{ type: 'tr' }], [{ type: 'tr' }, { type: 'tr' }, { type: 'tr' }])).toBeGreaterThanOrEqual(3);
  });
});

describe('fees', () => {
  it('estimates a taproot 4-in/5-out tx at roughly 450 vB', () => {
    const v = estimateVsize(Array(4).fill({ type: 'tr' }), Array(5).fill({ type: 'tr' }));
    expect(v).toBeGreaterThan(430);
    expect(v).toBeLessThan(470);
  });
  it('royalty math floors', () => {
    expect(royaltyFor(100_000, 250)).toBe(2_500n);
    expect(royaltyFor(99_999, 1)).toBe(9n);
    expect(royaltyFor(100_000, 0)).toBe(0n);
  });
});
