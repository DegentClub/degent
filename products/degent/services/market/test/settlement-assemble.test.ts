import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import {
  SELLER_SIGHASH,
  assembleBuyerSigned,
  assertRawInscriptionToBuyer,
  buildBuyerPsbt,
  buildSellerTemplate,
  extractSellerSignature,
} from '../src/domain/settlement/index.js';
import { NET, TXIDS, keyFromSeed, tamperOutput, walletSign } from './fakes/keys.js';

const seller = keyFromSeed('seller');
const buyer = keyFromSeed('buyer');
const inscriptionUtxo = { txid: TXIDS.inscription, vout: 1, value: 10_000 };
const PRICE = 250_000;

function built() {
  const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
  const sig = extractSellerSignature(walletSign(t.psbtHex, seller.priv, [2], SELLER_SIGHASH));
  return buildBuyerPsbt({
    listing: { inscriptionUtxo, satOffset: 0, sellerAddress: seller.tr.address, priceSats: PRICE, sellerSignature: sig },
    buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex,
    dummyUtxos: [{ txid: TXIDS.dummy, vout: 0, value: 600 }, { txid: TXIDS.dummy, vout: 1, value: 600 }],
    paymentUtxos: [{ txid: TXIDS.pay1, vout: 0, value: 300_000 }], feeRate: 5, network: NET,
  });
}

describe('assembleBuyerSigned', () => {
  it('merges wallet signatures into a fully final raw transaction; the raw bytes still route the inscription to the buyer', () => {
    const res = built();
    const signed = walletSign(res.psbtHex, buyer.priv, res.buyerInputIndexes, undefined, { finalize: true });
    const out = assembleBuyerSigned({ sessionPsbt: res.psbtHex, signedPsbt: signed, buyerInputIndexes: res.buyerInputIndexes });
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);
    const raw = btc.RawTx.decode(hex.decode(out.rawTxHex));
    expect(raw.inputs).toHaveLength(4);
    expect(raw.witnesses![2]!).toHaveLength(1);
    expect(raw.witnesses![2]![0]!).toHaveLength(65); // seller: 0x83
    expect(raw.witnesses![0]![0]!).toHaveLength(64); // buyer: SIGHASH_DEFAULT
    const prevouts = new Map(res.prevouts.map(([k, v]) => [k, BigInt(v)] as const));
    expect(assertRawInscriptionToBuyer(out.rawTxHex, prevouts, { satOffset: 0, buyerScript: buyer.tr.script, postage: 10_000n })).toEqual({ vout: 1, offset: 0n });
  });

  it('accepts partial (unfinalized) wallet signatures and base64 PSBTs', () => {
    const res = built();
    const signed = walletSign(res.psbtHex, buyer.priv, res.buyerInputIndexes);
    const b64 = Buffer.from(hex.decode(signed)).toString('base64');
    expect(() => assembleBuyerSigned({ sessionPsbt: res.psbtBase64, signedPsbt: b64, buyerInputIndexes: res.buyerInputIndexes })).not.toThrow();
  });

  it('rejects a wallet response whose transaction was altered (bigger royalty/change, underpaid seller)', () => {
    const res = built();
    for (const [idx, amount] of [[3, 1n], [2, 1_000n], [1, 9_999n]] as const) {
      const tampered = tamperOutput(res.psbtHex, idx, amount, buyer.priv);
      expect(() => assembleBuyerSigned({ sessionPsbt: res.psbtHex, signedPsbt: tampered, buyerInputIndexes: res.buyerInputIndexes })).toThrow(/does not match/);
    }
  });

  it('rejects when an input the buyer had to sign is missing a signature', () => {
    const res = built();
    const signed = walletSign(res.psbtHex, buyer.priv, [0, 1]);
    expect(() => assembleBuyerSigned({ sessionPsbt: res.psbtHex, signedPsbt: signed, buyerInputIndexes: res.buyerInputIndexes })).toThrow(/not signed/);
  });

  it('the raw guard refuses bytes that spend a different outpoint set', () => {
    const res = built();
    const signed = walletSign(res.psbtHex, buyer.priv, res.buyerInputIndexes, undefined, { finalize: true });
    const out = assembleBuyerSigned({ sessionPsbt: res.psbtHex, signedPsbt: signed, buyerInputIndexes: res.buyerInputIndexes });
    const prevouts = new Map(res.prevouts.slice(1).map(([k, v]) => [k, BigInt(v)] as const));
    expect(() => assertRawInscriptionToBuyer(out.rawTxHex, prevouts, { satOffset: 0, buyerScript: buyer.tr.script, postage: 10_000n })).toThrow(/unexpected outpoint/);
  });
});
