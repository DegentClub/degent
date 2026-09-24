import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { INSCRIPTION_INPUT_INDEX, PRICE_OUTPUT_INDEX } from '@bsh/degent-market-sdk';
import { SELLER_SIGHASH, buildBuyerPsbt, buildSellerTemplate, extractSellerSignature, parsePsbt, verifyInputSignature } from '../src/domain/settlement/index.js';
import { NET, TXIDS, keyFromSeed, walletSign } from './fakes/keys.js';

const seller = keyFromSeed('seller');
const buyer = keyFromSeed('buyer');
const inscriptionUtxo = { txid: TXIDS.inscription, vout: 1, value: 10_000 };
const PRICE = 250_000;
const dummies = [{ txid: TXIDS.dummy, vout: 0, value: 600 }, { txid: TXIDS.dummy, vout: 1, value: 600 }];
const payments = [{ txid: TXIDS.pay1, vout: 0, value: 300_000 }];

describe('buildSellerTemplate', () => {
  it('3-input / 3-output template: inscription at input 2, price at output 2, untweaked internal key', () => {
    const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    expect(t.signIndex).toBe(2);
    expect(t.sighashType).toBe(0x83);
    const tx = btc.Transaction.fromPSBT(hex.decode(t.psbtHex), { allowUnknownInputs: true });
    expect(tx.inputsLength).toBe(3);
    expect(tx.outputsLength).toBe(3);
    const insc = tx.getInput(INSCRIPTION_INPUT_INDEX);
    expect(hex.encode(insc.txid!)).toBe(TXIDS.inscription);
    expect(insc.index).toBe(1);
    expect(insc.sighashType).toBe(SELLER_SIGHASH);
    expect(insc.witnessUtxo!.amount).toBe(10_000n);
    expect(hex.encode(insc.tapInternalKey!)).toBe(seller.publicKeyHex.slice(2));
    expect(hex.encode(insc.tapInternalKey!)).not.toBe(hex.encode(seller.tr.tweakedPubkey));
    const out = tx.getOutput(PRICE_OUTPUT_INDEX);
    expect(out.amount).toBe(BigInt(PRICE));
    expect(hex.encode(out.script!)).toBe(hex.encode(seller.tr.script));
    expect(hex.encode(tx.getInput(0).txid!)).toBe('00'.repeat(32));
    expect(tx.getInput(0).sighashType).toBeUndefined();
    expect(parsePsbt(t.psbtBase64).inputsLength).toBe(3); // base64 accepted too
  });

  it('rejects a public key that does not derive the address, and non-positive prices', () => {
    expect(() => buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: buyer.publicKeyHex, priceSats: PRICE, network: NET })).toThrow(/does not derive/);
    expect(() => buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: 0, network: NET })).toThrow(/positive/);
  });

  it('extracts a 65-byte Schnorr signature ending in 0x83 that verifies against the template', () => {
    const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    const signed = walletSign(t.psbtHex, seller.priv, [2], SELLER_SIGHASH);
    const sig = extractSellerSignature(signed, { unsignedTxHex: t.unsignedTxHex, inscriptionUtxo, sellerAddress: seller.tr.address, priceSats: PRICE, network: NET });
    expect(sig.kind).toBe('schnorr');
    expect(sig.signatureHex).toHaveLength(130);
    expect(sig.signatureHex.slice(-2)).toBe('83');
    expect(verifyInputSignature(btc.Transaction.fromPSBT(hex.decode(t.psbtHex), { allowUnknownInputs: true }), 2, sig)).toBe(true);
  });

  it('rejects a signature made with the wrong sighash', () => {
    const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    const tx = btc.Transaction.fromPSBT(hex.decode(t.psbtHex), { allowUnknownInputs: true });
    tx.updateInput(2, { sighashType: 0x00 });
    tx.signIdx(seller.priv, 2);
    expect(() => extractSellerSignature(hex.encode(tx.toPSBT()))).toThrow(/65-byte|sighash/i);
  });

  it('rejects a signed PSBT whose transaction differs from the template (other price)', () => {
    const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    const other = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE - 1, network: NET });
    const signedOther = walletSign(other.psbtHex, seller.priv, [2], SELLER_SIGHASH);
    expect(() => extractSellerSignature(signedOther, { unsignedTxHex: t.unsignedTxHex, inscriptionUtxo, sellerAddress: seller.tr.address, priceSats: PRICE, network: NET })).toThrow(/does not match/);
  });

  it('rejects an unsigned template and a garbage PSBT', () => {
    const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    expect(() => extractSellerSignature(t.psbtHex)).toThrow(/no signature/);
    expect(() => extractSellerSignature('zz not a psbt')).toThrow(/PSBT/);
  });

  it('supports a native segwit (P2WPKH) seller with an ECDSA signature, verified on the real purchase', () => {
    const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.wpkh.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    const signed = walletSign(t.psbtHex, seller.priv, [2], SELLER_SIGHASH);
    const sig = extractSellerSignature(signed, { unsignedTxHex: t.unsignedTxHex, inscriptionUtxo, sellerAddress: seller.wpkh.address, priceSats: PRICE, network: NET });
    expect(sig.kind).toBe('ecdsa');
    expect(sig.publicKeyHex).toBe(seller.publicKeyHex);
    const res = buildBuyerPsbt({
      listing: { inscriptionUtxo, satOffset: 0, sellerAddress: seller.wpkh.address, priceSats: PRICE, sellerSignature: sig },
      buyerAddress: buyer.tr.address, buyerPublicKey: buyer.publicKeyHex, dummyUtxos: dummies, paymentUtxos: payments, feeRate: 5, network: NET,
    });
    expect(res.destination.vout).toBe(1);
  });

  it('a signature from another key does not verify', () => {
    const impostor = keyFromSeed('impostor');
    const t = buildSellerTemplate({ inscriptionUtxo, sellerAddress: impostor.tr.address, sellerPublicKey: impostor.publicKeyHex, priceSats: PRICE, network: NET });
    const sig = extractSellerSignature(walletSign(t.psbtHex, impostor.priv, [2], SELLER_SIGHASH));
    const mine = buildSellerTemplate({ inscriptionUtxo, sellerAddress: seller.tr.address, sellerPublicKey: seller.publicKeyHex, priceSats: PRICE, network: NET });
    expect(verifyInputSignature(btc.Transaction.fromPSBT(hex.decode(mine.psbtHex), { allowUnknownInputs: true }), 2, sig)).toBe(false);
  });
});
