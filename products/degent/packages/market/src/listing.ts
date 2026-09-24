/**
 * Seller side. A listing is a signature, not a transaction: the seller signs their inscription
 * input with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY (0x83) over a transaction in which that input
 * sits at LAYOUT.inscriptionInputIndex and the output at the SAME index pays the seller the price.
 *
 * What 0x83 commits to (BIP341, this input only + the output at its index):
 *   - nVersion, nLockTime, this input's outpoint, amount, scriptPubKey and nSequence;
 *   - the output at index 2: (seller address, price).
 * What it does NOT commit to: any other input or output. That is exactly the freedom the buyer
 * needs to add padding inputs, their payment, the output that receives the inscription and change,
 * and it is also why the buyer's layout, not the seller's signature, decides where the inscribed
 * sat lands (see purchase.ts and the README).
 *
 * The seller's inscription UTXO must be P2TR key-path (an ordinals address). The seller never
 * hands over a key: only the 65-byte signature travels.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { Address, OutScript, SigHash, Transaction } from '@scure/btc-signer';
import { networkParams, type Network } from './network.js';

export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

/**
 * The purchase layout every listing is signed against. Inputs before the inscription are the
 * buyer's PADDING ("dummy") inputs; their sats fill output 0 exactly, so under ordinal FIFO the
 * inscription input's first sat is the first sat of output 1, which the buyer owns.
 */
export const LAYOUT = Object.freeze({
  /** Buyer padding inputs occupy indexes 0 .. inscriptionInputIndex-1. */
  paddingInputs: 2,
  inscriptionInputIndex: 2,
  paddingMergeOutputIndex: 0,
  buyerReceiveOutputIndex: 1,
  sellerPaymentOutputIndex: 2,
});

export interface InscriptionUtxo {
  txid: string;
  vout: number;
  value: bigint;
  /** P2TR scriptPubKey of the UTXO (0x5120 || 32-byte output key). */
  script: Uint8Array;
  /** Offset of the inscribed sat inside the UTXO (0 for a reveal's child output). */
  inscriptionOffset?: number;
}

export interface Listing {
  kind: 'degent.market/listing';
  version: 1;
  network: Network;
  inscription: { txid: string; vout: number; value: string; scriptHex: string; inscriptionOffset: number };
  sellerReceiveAddress: string;
  priceSats: string;
  /** 65 bytes: Schnorr signature || 0x83. Valid ONLY with the input at index 2 and (sellerReceiveAddress, priceSats) at output 2. */
  sellerSignatureHex: string;
  /** Layout the signature assumes; a buyer must build exactly this. */
  layout: typeof LAYOUT;
}

export const PLACEHOLDER_SEQUENCE = 0xfffffffd;
export const TX_VERSION = 2;

function isP2TR(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}

/** A neutral, non-spendable-looking placeholder input/output used only to give the sighash its index. */
function placeholderOutpoint(i: number): { txid: Uint8Array; index: number } {
  const txid = new Uint8Array(32);
  txid[31] = i + 1;
  return { txid, index: 0 };
}

/**
 * The transaction skeleton whose 0x83 digest for input 2 equals the digest of ANY purchase built
 * to LAYOUT with the same (input 2, output 2). Used by the seller to sign and by anyone to verify.
 */
export function listingSkeleton(args: {
  network: Network;
  inscription: InscriptionUtxo;
  sellerReceiveAddress: string;
  priceSats: bigint;
}): { tx: Transaction; sellerScript: Uint8Array } {
  const net = networkParams(args.network);
  const sellerScript = OutScript.encode(Address(net).decode(args.sellerReceiveAddress));
  const tx = new Transaction({ version: TX_VERSION, lockTime: 0, allowUnknownInputs: true });
  for (let i = 0; i < LAYOUT.inscriptionInputIndex; i++) {
    tx.addInput({ ...placeholderOutpoint(i), sequence: PLACEHOLDER_SEQUENCE, witnessUtxo: { script: sellerScript, amount: 1n } });
  }
  tx.addInput({
    txid: hex.decode(args.inscription.txid),
    index: args.inscription.vout,
    sequence: PLACEHOLDER_SEQUENCE,
    witnessUtxo: { script: args.inscription.script, amount: args.inscription.value },
    sighashType: SIGHASH_SINGLE_ANYONECANPAY,
  });
  for (let i = 0; i < LAYOUT.sellerPaymentOutputIndex; i++) tx.addOutput({ script: sellerScript, amount: 1n });
  tx.addOutput({ script: sellerScript, amount: args.priceSats });
  return { tx, sellerScript };
}

export function buildSellerListing(args: {
  network: Network;
  inscription: InscriptionUtxo;
  /** 32-byte private key whose x-only public key is the P2TR internal key of the inscription UTXO (BIP86, no script tree). */
  sellerPrivkey: Uint8Array;
  sellerReceiveAddress: string;
  priceSats: bigint;
}): Listing {
  if (!isP2TR(args.inscription.script)) throw new Error('inscription UTXO must be P2TR (key path)');
  if (args.priceSats <= 0n) throw new RangeError('priceSats must be positive');
  if (args.inscription.value <= 0n) throw new RangeError('inscription value must be positive');
  const offset = args.inscription.inscriptionOffset ?? 0;
  if (offset < 0 || BigInt(offset) >= args.inscription.value) throw new RangeError('inscriptionOffset outside the UTXO');
  const internalKey = schnorr.getPublicKey(args.sellerPrivkey);
  const { tx } = listingSkeleton(args);
  tx.updateInput(LAYOUT.inscriptionInputIndex, { tapInternalKey: internalKey });
  const ok = tx.signIdx(args.sellerPrivkey, LAYOUT.inscriptionInputIndex, [SigHash.SINGLE_ANYONECANPAY]);
  if (!ok) throw new Error('could not sign the inscription input: key does not match the UTXO');
  const sig = tx.getInput(LAYOUT.inscriptionInputIndex).tapKeySig;
  if (!sig || sig.length !== 65 || sig[64] !== SIGHASH_SINGLE_ANYONECANPAY) throw new Error('unexpected signature encoding');
  return {
    kind: 'degent.market/listing',
    version: 1,
    network: args.network,
    inscription: {
      txid: args.inscription.txid.toLowerCase(),
      vout: args.inscription.vout,
      value: args.inscription.value.toString(),
      scriptHex: hex.encode(args.inscription.script),
      inscriptionOffset: offset,
    },
    sellerReceiveAddress: args.sellerReceiveAddress,
    priceSats: args.priceSats.toString(),
    sellerSignatureHex: hex.encode(sig),
    layout: LAYOUT,
  };
}

export function inscriptionUtxoOf(listing: Listing): InscriptionUtxo {
  return {
    txid: listing.inscription.txid,
    vout: listing.inscription.vout,
    value: BigInt(listing.inscription.value),
    script: hex.decode(listing.inscription.scriptHex),
    inscriptionOffset: listing.inscription.inscriptionOffset,
  };
}

/**
 * BIP341 digest the seller signed, computed over any transaction `tx` that has the listing's input
 * at index 2: with 0x83 only that input and output 2 matter, so the skeleton and a real purchase
 * yield the same digest.
 */
export function sellerSighash(tx: Transaction, prevScripts: Uint8Array[], amounts: bigint[]): Uint8Array {
  return tx.preimageWitnessV1(LAYOUT.inscriptionInputIndex, prevScripts, SIGHASH_SINGLE_ANYONECANPAY, amounts);
}

/** Schnorr-verify the listing signature against the inscription UTXO's output key. */
export function verifyListing(listing: Listing): { ok: true } | { ok: false; reason: string } {
  try {
    if (listing.kind !== 'degent.market/listing' || listing.version !== 1) return { ok: false, reason: 'not a v1 listing' };
    const utxo = inscriptionUtxoOf(listing);
    if (!isP2TR(utxo.script)) return { ok: false, reason: 'inscription UTXO is not P2TR' };
    const price = BigInt(listing.priceSats);
    if (price <= 0n) return { ok: false, reason: 'non-positive price' };
    const sig = hex.decode(listing.sellerSignatureHex);
    if (sig.length !== 65 || sig[64] !== SIGHASH_SINGLE_ANYONECANPAY) return { ok: false, reason: 'signature is not 64 bytes + 0x83' };
    const { tx, sellerScript } = listingSkeleton({ network: listing.network, inscription: utxo, sellerReceiveAddress: listing.sellerReceiveAddress, priceSats: price });
    const prevScripts = [sellerScript, sellerScript, utxo.script];
    const amounts = [1n, 1n, utxo.value];
    const digest = sellerSighash(tx, prevScripts, amounts);
    const outputKey = utxo.script.slice(2);
    return schnorr.verify(sig.slice(0, 64), digest, outputKey) ? { ok: true } : { ok: false, reason: 'signature does not verify' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
