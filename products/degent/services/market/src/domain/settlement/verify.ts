/**
 * Cryptographic verification of the seller's signature against a concrete transaction, and assembly of
 * the buyer-signed PSBT before broadcast.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { equalBytes, hash160 } from '@scure/btc-signer/utils.js';
import { SIGHASH_SINGLE_ANYONECANPAY } from '@bsh/degent-market-sdk';
import { SettlementError } from '../errors.js';
import { STRICT_TX, parsePsbt } from './addresses.js';
import type { SellerSignature } from './seller.js';

/**
 * Verify a SINGLE|ANYONECANPAY signature on input `inputIndex` of `tx` (every input must carry
 * witness_utxo). Taproot: BIP341 digest, Schnorr against the OUTPUT (tweaked) key in the scriptPubKey,
 * exactly as consensus checks, independent of how the wallet derived its internal key. P2WPKH: BIP143
 * digest, ECDSA (DER, low-S not required here: consensus accepts high-S, policy does not).
 */
export function verifyInputSignature(tx: btc.Transaction, inputIndex: number, sig: SellerSignature): boolean {
  const scripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).witnessUtxo;
    if (!w) return false;
    scripts.push(w.script);
    amounts.push(w.amount);
  }
  let bytes: Uint8Array;
  try {
    bytes = hex.decode(sig.signatureHex);
  } catch {
    return false;
  }
  const hashType = bytes[bytes.length - 1];
  if (hashType !== SIGHASH_SINGLE_ANYONECANPAY) return false;
  const prevScript = scripts[inputIndex];
  if (!prevScript) return false;
  let prev;
  try {
    prev = btc.OutScript.decode(prevScript);
  } catch {
    return false;
  }
  try {
    if (sig.kind === 'schnorr') {
      if (prev.type !== 'tr' || bytes.length !== 65) return false;
      const msg = tx.preimageWitnessV1(inputIndex, scripts, hashType, amounts);
      return schnorr.verify(bytes.subarray(0, 64), msg, prev.pubkey);
    }
    if (sig.kind === 'ecdsa') {
      if (prev.type !== 'wpkh' || !sig.publicKeyHex) return false;
      const pub = hex.decode(sig.publicKeyHex);
      if (!equalBytes(hash160(pub), prev.hash)) return false;
      const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: prev.hash });
      const msg = tx.preimageWitnessV0(inputIndex, scriptCode, hashType, amounts[inputIndex]!);
      return secp256k1.verify(bytes.subarray(0, -1), msg, pub, { prehash: false, format: 'der', lowS: false });
    }
  } catch {
    return false;
  }
  return false;
}

/** The seller's witness, ready to be attached as a finalized input. */
export function sellerWitness(sig: SellerSignature): Uint8Array[] {
  return sig.kind === 'ecdsa' ? [hex.decode(sig.signatureHex), hex.decode(sig.publicKeyHex ?? '')] : [hex.decode(sig.signatureHex)];
}

export interface AssembledTx {
  rawTxHex: string;
  txid: string;
  vsize: number;
  fee: bigint;
  tx: btc.Transaction;
}

/**
 * Check the PSBT the buyer's wallet returned against the PSBT the service issued: same unsigned
 * transaction byte-for-byte (no input/output tampering), every input the buyer had to sign is signed.
 * Only signature material is taken from the wallet's copy; everything else (witness_utxo, the seller's
 * finalized witness) comes from the service's copy. Returns the finalized raw transaction.
 */
export function assembleBuyerSigned(a: { sessionPsbt: string | Uint8Array; signedPsbt: string | Uint8Array; buyerInputIndexes: readonly number[] }): AssembledTx {
  const expected = parsePsbt(a.sessionPsbt, STRICT_TX);
  const signed = parsePsbt(a.signedPsbt, STRICT_TX);
  if (hex.encode(signed.unsignedTx) !== hex.encode(expected.unsignedTx))
    throw new SettlementError('bad_psbt', 'signed PSBT does not match the transaction the service built');

  for (const idx of a.buyerInputIndexes) {
    const w = signed.getInput(idx);
    if (w.finalScriptWitness?.length) expected.updateInput(idx, { finalScriptWitness: w.finalScriptWitness }, true);
    else if (w.tapKeySig) expected.updateInput(idx, { tapKeySig: w.tapKeySig }, true);
    else if (w.partialSig?.length) expected.updateInput(idx, { partialSig: w.partialSig }, true);
    else throw new SettlementError('bad_psbt', `input ${idx} was not signed by the wallet`);
  }
  for (let i = 0; i < expected.inputsLength; i++) {
    if (expected.getInput(i).finalScriptWitness?.length) continue;
    try {
      expected.finalizeIdx(i);
    } catch (e) {
      throw new SettlementError('bad_psbt', `cannot finalize input ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!expected.isFinal) throw new SettlementError('bad_psbt', 'transaction still has unfinalized inputs');
  const raw = expected.extract();
  return { rawTxHex: hex.encode(raw), txid: expected.id, vsize: expected.vsize, fee: expected.fee, tx: expected };
}
