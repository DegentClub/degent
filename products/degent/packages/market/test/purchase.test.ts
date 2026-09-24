/**
 * Real transactions: the seller lists (0x83), the buyer builds the purchase and signs it, and the
 * final raw transaction is checked three ways: the seller's Schnorr signature over the FINAL tx's
 * BIP341 digest, every buyer signature, and ordinal FIFO placement of the inscribed sat.
 */
import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, hex } from '@scure/base';
import { OutScript, p2tr, p2wpkh, Transaction } from '@scure/btc-signer';
import {
  buildPurchase,
  buildSellerListing,
  estimatePurchaseWeight,
  finalizePurchase,
  inscriptionDestination,
  InsufficientFundsError,
  LAYOUT,
  networkParams,
  verifyListing,
  type BuyerUtxo,
  type Listing,
} from '../src/index.js';

const NET = 'regtest' as const;
const net = networkParams(NET);
const OPTS = { allowUnknownInputs: true, allowUnknownOutputs: true } as const;

const sellerKey = new Uint8Array(32).fill(1);
const sellerPay = p2tr(schnorr.getPublicKey(sellerKey), undefined, net);
const sellerReceiveKey = new Uint8Array(32).fill(9);
const sellerReceive = p2tr(schnorr.getPublicKey(sellerReceiveKey), undefined, net);
const buyerTrKey = new Uint8Array(32).fill(2);
const buyerTr = p2tr(schnorr.getPublicKey(buyerTrKey), undefined, net);
const buyerWpkhKey = new Uint8Array(32).fill(3);
const buyerWpkhPub = secp256k1.getPublicKey(buyerWpkhKey, true);
const buyerWpkh = p2wpkh(buyerWpkhPub, net);
const buyerOrdKey = new Uint8Array(32).fill(4);
const buyerOrd = p2tr(schnorr.getPublicKey(buyerOrdKey), undefined, net);

const txid = (label: string) => hex.encode(sha256(new TextEncoder().encode(label)));

function listingFor(price: bigint, postage: bigint, offset = 0): Listing {
  return buildSellerListing({
    network: NET,
    inscription: { txid: txid('inscription'), vout: 1, value: postage, script: sellerPay.script, inscriptionOffset: offset },
    sellerPrivkey: sellerKey,
    sellerReceiveAddress: sellerReceive.address!,
    priceSats: price,
  });
}

function trUtxo(label: string, value: bigint): BuyerUtxo {
  return { txid: txid(label), vout: 0, value, script: buyerTr.script, tapInternalKey: schnorr.getPublicKey(buyerTrKey) };
}
function wpkhUtxo(label: string, value: bigint): BuyerUtxo {
  return { txid: txid(label), vout: 0, value, script: buyerWpkh.script };
}

/** The buyer's wallet: sign every buyer input (no finalization, like sats-connect wallets). */
function buyerSigns(psbtBase64: string, inputsToSign: number[]): string {
  const tx = Transaction.fromPSBT(base64.decode(psbtBase64), OPTS);
  for (const i of inputsToSign) {
    const script = tx.getInput(i).witnessUtxo!.script!;
    const ok = tx.signIdx(script.length === 34 ? buyerTrKey : buyerWpkhKey, i);
    expect(ok).toBe(true);
  }
  return base64.encode(tx.toPSBT());
}

function buyerSignsAndFinalizes(psbtBase64: string, inputsToSign: number[], listing: Listing): Transaction {
  const signed = buyerSigns(psbtBase64, inputsToSign);
  const f = finalizePurchase(signed, listing);
  // A wallet that finalizes everything itself (btc-signer's finalize()) gets the same bytes.
  const alt = Transaction.fromPSBT(base64.decode(signed), OPTS);
  alt.finalize();
  expect(hex.encode(alt.extract())).toBe(f.hex);
  return Transaction.fromRaw(hex.decode(f.hex), OPTS);
}

function prevouts(final: Transaction, listing: Listing, buyerInputs: BuyerUtxo[]) {
  const scripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < final.inputsLength; i++) {
    if (i === LAYOUT.inscriptionInputIndex) {
      scripts.push(hex.decode(listing.inscription.scriptHex));
      amounts.push(BigInt(listing.inscription.value));
    } else {
      const inp = final.getInput(i);
      const u = buyerInputs.find((b) => b.txid === hex.encode(inp.txid!) && b.vout === inp.index)!;
      scripts.push(u.script);
      amounts.push(u.value);
    }
  }
  return { scripts, amounts };
}

function verifySeller(final: Transaction, listing: Listing, buyerInputs: BuyerUtxo[]): boolean {
  const { scripts, amounts } = prevouts(final, listing, buyerInputs);
  const digest = final.preimageWitnessV1(LAYOUT.inscriptionInputIndex, scripts, 0x83, amounts);
  const sig = hex.decode(listing.sellerSignatureHex);
  return schnorr.verify(sig.slice(0, 64), digest, hex.decode(listing.inscription.scriptHex).slice(2));
}

function verifyBuyerInputs(final: Transaction, listing: Listing, buyerInputs: BuyerUtxo[]): void {
  const { scripts, amounts } = prevouts(final, listing, buyerInputs);
  for (let i = 0; i < final.inputsLength; i++) {
    if (i === LAYOUT.inscriptionInputIndex) continue;
    const w = final.getInput(i).finalScriptWitness!;
    if (scripts[i]!.length === 34) {
      expect(w).toHaveLength(1);
      expect(w[0]!.length).toBe(64); // SIGHASH_DEFAULT, no hash-type byte
      const digest = final.preimageWitnessV1(i, scripts, 0x00, amounts);
      expect(schnorr.verify(w[0]!, digest, buyerTr.tweakedPubkey)).toBe(true);
    } else {
      expect(w).toHaveLength(2);
      expect(w[1]).toEqual(buyerWpkhPub);
      const sig = w[0]!;
      expect(sig[sig.length - 1]).toBe(0x01); // SIGHASH_ALL
      const pkh = OutScript.encode({ type: 'pkh', hash: OutScript.decode(scripts[i]!).type === 'wpkh' ? (OutScript.decode(scripts[i]!) as { hash: Uint8Array }).hash : new Uint8Array() });
      const digest = final.preimageWitnessV0(i, pkh, 0x01, amounts[i]!);
      // preimageWitnessV0 already returns the double-SHA256 digest; verify it as-is (no prehash).
      expect(secp256k1.verify(secp256k1.Signature.fromBytes(sig.slice(0, -1), 'der').toBytes('compact'), digest, buyerWpkhPub, { prehash: false })).toBe(true);
    }
  }
}

describe('seller listing (SIGHASH_SINGLE|ANYONECANPAY at index 2)', () => {
  it('produces a 65-byte signature that verifies, and refuses tampering with price, address or UTXO', () => {
    const l = listingFor(50_000n, 546n);
    expect(l.sellerSignatureHex).toHaveLength(130);
    expect(l.sellerSignatureHex.endsWith('83')).toBe(true);
    expect(verifyListing(l)).toEqual({ ok: true });
    expect(verifyListing({ ...l, priceSats: '49999' }).ok).toBe(false);
    expect(verifyListing({ ...l, sellerReceiveAddress: buyerOrd.address! }).ok).toBe(false);
    expect(verifyListing({ ...l, inscription: { ...l.inscription, value: '547' } }).ok).toBe(false);
    expect(verifyListing({ ...l, inscription: { ...l.inscription, vout: 0 } }).ok).toBe(false);
    expect(verifyListing({ ...l, sellerSignatureHex: l.sellerSignatureHex.slice(0, -2) + '81' }).ok).toBe(false);
  });

  it('refuses a key that does not own the UTXO, non-P2TR UTXOs and bad prices', () => {
    const utxo = { txid: txid('x'), vout: 0, value: 546n, script: sellerPay.script };
    expect(() => buildSellerListing({ network: NET, inscription: utxo, sellerPrivkey: buyerTrKey, sellerReceiveAddress: sellerReceive.address!, priceSats: 1n })).toThrow(/key|Taproot commitment/);
    expect(() => buildSellerListing({ network: NET, inscription: { ...utxo, script: buyerWpkh.script }, sellerPrivkey: sellerKey, sellerReceiveAddress: sellerReceive.address!, priceSats: 1n })).toThrow(/P2TR/);
    expect(() => buildSellerListing({ network: NET, inscription: utxo, sellerPrivkey: sellerKey, sellerReceiveAddress: sellerReceive.address!, priceSats: 0n })).toThrow(/price/);
  });
});

describe('buyer purchase: real signed transactions', () => {
  const cases: Array<[string, bigint, bigint, bigint, bigint, number, 'p2tr' | 'p2wpkh', number, number]> = [
    ['small, taproot buyer', 1_000n, 546n, 600n, 600n, 2, 'p2tr', 0, 0],
    ['typical, taproot buyer, new padding', 50_000n, 546n, 600n, 600n, 5, 'p2tr', 2, 0],
    ['big, taproot buyer, uneven padding', 1_000_000n, 10_000n, 600n, 5_000n, 12.5, 'p2tr', 0, 100],
    ['typical, segwit buyer', 50_000n, 330n, 1_000n, 1_000n, 3, 'p2wpkh', 0, 0],
    ['big, segwit buyer, new padding', 2_500_000n, 546n, 600n, 600n, 30, 'p2wpkh', 2, 1],
  ];

  it.each(cases)('%s: price %d, postage %d, padding %d+%d, %d sat/vB', (_name, price, postage, a, b, feeRate, kind, newPadding, offset) => {
    const listing = listingFor(price, postage, offset);
    const mk = kind === 'p2tr' ? trUtxo : wpkhUtxo;
    const buyerInputs = [mk('padA', a), mk('padB', b), mk('pay1', price / 2n + 20_000n), mk('pay2', price + 100_000n)];
    const purchase = buildPurchase({
      network: NET,
      listing,
      buyer: { padding: [buyerInputs[0]!, buyerInputs[1]!], payments: buyerInputs.slice(2), receiveAddress: buyerOrd.address!, changeAddress: kind === 'p2tr' ? buyerTr.address! : buyerWpkh.address! },
      feeRate,
      newPaddingOutputs: newPadding,
    });

    // Layout as promised.
    expect(purchase.inputsToSign).not.toContain(LAYOUT.inscriptionInputIndex);
    expect(purchase.outputs.map((o) => o.label)).toEqual(['padding-merge', 'buyer-receive', 'seller-payment', 'change', ...Array(newPadding).fill('new-padding')]);
    expect(purchase.outputs[0]).toMatchObject({ value: a + b });
    expect(purchase.outputs[1]).toMatchObject({ address: buyerOrd.address, value: postage });
    expect(purchase.outputs[2]).toMatchObject({ address: sellerReceive.address, value: price });
    expect(purchase.inscriptionLandsIn).toEqual({ kind: 'output', index: 1, offset: BigInt(offset) });

    // Before the buyer signs: the PSBT already carries the seller's key-path signature at input 2 and honest sighash types.
    const psbt = Transaction.fromPSBT(base64.decode(purchase.psbtBase64), OPTS);
    expect(psbt.getInput(2).tapKeySig).toEqual(hex.decode(listing.sellerSignatureHex));
    expect(psbt.getInput(2).sighashType).toBe(0x83);
    for (const i of purchase.inputsToSign) expect(psbt.getInput(i).sighashType).toBe(0x00);

    const final = buyerSignsAndFinalizes(purchase.psbtBase64, purchase.inputsToSign, listing);
    expect(final.inputsLength).toBe(2 + 1 + purchase.inputsToSign.length - 2);

    // 1. The seller's 0x83 signature verifies over the FINAL transaction's BIP341 digest.
    expect(verifySeller(final, listing, buyerInputs)).toBe(true);
    expect(final.getInput(2).finalScriptWitness).toEqual([hex.decode(listing.sellerSignatureHex)]);

    // 2. Every buyer signature verifies.
    verifyBuyerInputs(final, listing, buyerInputs);

    // 3. Fee and size.
    const inValues = [a, b, postage, ...buyerInputs.slice(2, 2 + purchase.inputsToSign.length - 2).map((u) => u.value)];
    const outValues = Array.from({ length: final.outputsLength }, (_, i) => final.getOutput(i).amount!);
    const fee = inValues.reduce((x, y) => x + y, 0n) - outValues.reduce((x, y) => x + y, 0n);
    expect(fee).toBe(purchase.fee);
    expect(Number(fee) / final.vsize).toBeGreaterThanOrEqual(feeRate);
    if (kind === 'p2tr') {
      expect(final.weight).toBe(purchase.weight); // exact: Schnorr signatures are fixed size
      expect(final.vsize).toBe(purchase.vsize);
    } else {
      const ecdsaInputs = purchase.inputsToSign.length;
      expect(final.weight).toBeLessThanOrEqual(purchase.weight); // DER may be a byte shorter per input
      expect(purchase.weight - final.weight).toBeLessThanOrEqual(ecdsaInputs);
    }
    expect(purchase.weight).toBe(
      estimatePurchaseWeight({
        inputs: [{ kind }, { kind }, { kind: 'p2tr', sighashDefault: false }, ...Array(purchase.inputsToSign.length - 2).fill({ kind })],
        outputScriptLengths: outValues.map((_, i) => final.getOutput(i).script!.length),
      }),
    );

    // 4. Ordinal FIFO on the final transaction: the inscribed sat is the first sat of output 1 (+ offset).
    expect(inscriptionDestination(inValues.map((v, i) => (i === 2 ? { value: v, inscriptionOffset: offset } : { value: v })), outValues.map((v) => ({ value: v })), fee)).toEqual({
      kind: 'output',
      index: 1,
      offset: BigInt(offset),
    });
    expect(final.getOutput(1).script).toEqual(buyerOrd.script);
  });

  it('what 0x83 does and does not protect: changing the seller output breaks the signature, changing the buyer output does not', () => {
    const listing = listingFor(50_000n, 546n);
    const buyerInputs = [trUtxo('padA', 600n), trUtxo('padB', 600n), trUtxo('pay', 200_000n)];
    const purchase = buildPurchase({ network: NET, listing, buyer: { padding: buyerInputs.slice(0, 2), payments: [buyerInputs[2]!], receiveAddress: buyerOrd.address!, changeAddress: buyerTr.address! }, feeRate: 2 });
    const final = buyerSignsAndFinalizes(purchase.psbtBase64, purchase.inputsToSign, listing);
    const { scripts, amounts } = prevouts(final, listing, buyerInputs);
    const sig = hex.decode(listing.sellerSignatureHex).slice(0, 64);
    const key = sellerPay.script.slice(2);
    const raw = final.toBytes(true, true);
    const digestOf = (mutate: (t: Transaction) => void) => {
      const t = Transaction.fromRaw(raw, OPTS);
      for (let i = 0; i < t.inputsLength; i++) t.updateInput(i, { witnessUtxo: { script: scripts[i]!, amount: amounts[i]! } }, true);
      mutate(t);
      return t.preimageWitnessV1(2, scripts, 0x83, amounts);
    };
    expect(schnorr.verify(sig, digestOf(() => undefined), key)).toBe(true);
    expect(schnorr.verify(sig, digestOf((t) => t.updateOutput(2, { amount: 49_999n }, true)), key)).toBe(false);
    expect(schnorr.verify(sig, digestOf((t) => t.updateOutput(2, { script: buyerOrd.script }, true)), key)).toBe(false);
    // Not covered by the seller's signature: output 1 and the padding. That is why the BUYER builds
    // the layout and this library proves placement, instead of trusting the seller's transaction.
    expect(schnorr.verify(sig, digestOf((t) => t.updateOutput(1, { amount: 547n }, true)), key)).toBe(true);
    expect(schnorr.verify(sig, digestOf((t) => t.updateOutput(0, { amount: 1_201n }, true)), key)).toBe(true);
  });

  it('refuses wrong network, tampered listings, missing padding and insufficient funds', () => {
    const listing = listingFor(50_000n, 546n);
    const pad = [trUtxo('padA', 600n), trUtxo('padB', 600n)];
    const buyer = { padding: pad, payments: [trUtxo('pay', 200_000n)], receiveAddress: buyerOrd.address!, changeAddress: buyerTr.address! };
    expect(() => buildPurchase({ network: 'mainnet', listing, buyer, feeRate: 2 })).toThrow(/network/);
    expect(() => buildPurchase({ network: NET, listing: { ...listing, priceSats: '1' }, buyer, feeRate: 2 })).toThrow(/invalid listing/);
    expect(() => buildPurchase({ network: NET, listing, buyer: { ...buyer, padding: [pad[0]!] }, feeRate: 2 })).toThrow(/padding/);
    expect(() => buildPurchase({ network: NET, listing, buyer: { ...buyer, receiveAddress: buyerWpkh.address! }, feeRate: 2 })).toThrow(/taproot/);
    expect(() => buildPurchase({ network: NET, listing, buyer: { ...buyer, payments: [trUtxo('poor', 50_100n)] }, feeRate: 2 })).toThrow(InsufficientFundsError);
  });

  it('drops a sub-dust change into the fee rather than creating dust', () => {
    const listing = listingFor(50_000n, 546n);
    const pad = [trUtxo('padA', 600n), trUtxo('padB', 600n)];
    const base = buildPurchase({ network: NET, listing, buyer: { padding: pad, payments: [trUtxo('pay', 200_000n)], receiveAddress: buyerOrd.address!, changeAddress: buyerTr.address! }, feeRate: 2 });
    const exact = buildPurchase({ network: NET, listing, buyer: { padding: pad, payments: [trUtxo('pay', 50_000n + base.fee + 100n)], receiveAddress: buyerOrd.address!, changeAddress: buyerTr.address! }, feeRate: 2 });
    expect(exact.outputs.map((o) => o.label)).toEqual(['padding-merge', 'buyer-receive', 'seller-payment']);
    expect(exact.fee).toBeGreaterThan(base.fee);
    expect(exact.inscriptionLandsIn).toEqual({ kind: 'output', index: 1, offset: 0n });
    const final = buyerSignsAndFinalizes(exact.psbtBase64, exact.inputsToSign, listing);
    expect(verifySeller(final, listing, [...pad, trUtxo('pay', 50_000n + base.fee + 100n)])).toBe(true);
  });

  it('finalizePurchase refuses a PSBT whose seller signature or seller output was swapped', () => {
    const listing = listingFor(50_000n, 546n);
    const pad = [trUtxo('padA', 600n), trUtxo('padB', 600n)];
    const purchase = buildPurchase({ network: NET, listing, buyer: { padding: pad, payments: [trUtxo('pay', 200_000n)], receiveAddress: buyerOrd.address!, changeAddress: buyerTr.address! }, feeRate: 2 });
    const signed = buyerSigns(purchase.psbtBase64, purchase.inputsToSign);
    const other = listingFor(49_000n, 546n);
    expect(() => finalizePurchase(signed, other)).toThrow(/seller's signature/);
    const t = Transaction.fromPSBT(base64.decode(signed), OPTS);
    t.updateInput(2, { tapKeySig: hex.decode(other.sellerSignatureHex) }, true);
    expect(() => finalizePurchase(base64.encode(t.toPSBT()), listing)).toThrow(/seller's signature/);
  });
});
