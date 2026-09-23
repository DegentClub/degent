// Cryptographic verification of the seller's signature against a concrete
// transaction, and checks on the buyer-signed PSBT before broadcast.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { hash160, equalBytes } from '@scure/btc-signer/utils.js';
import { decodeAddress, SIGHASH } from './addresses.js';

/**
 * Verify a SINGLE|ANYONECANPAY signature on `inputIndex` of `tx`.
 *
 * For taproot the signature is checked against the *output key* embedded in the
 * scriptPubKey (the tweaked key) — that is what consensus checks, and it makes
 * the verification independent of how the wallet derived its internal key.
 *
 * @param {btc.Transaction} tx      the transaction (inputs must carry witnessUtxo)
 * @param {number} inputIndex
 * @param {{signatureHex:string, kind:'schnorr'|'ecdsa', publicKeyHex?:string}} sig
 * @returns {boolean}
 */
export function verifyInputSignature(tx, inputIndex, sig) {
  const n = tx.inputsLength;
  const scripts = [];
  const amounts = [];
  for (let i = 0; i < n; i++) {
    const inp = tx.getInput(i);
    if (!inp.witnessUtxo) throw new Error(`input ${i} lacks witnessUtxo`);
    scripts.push(inp.witnessUtxo.script);
    amounts.push(inp.witnessUtxo.amount);
  }
  const bytes = hex.decode(sig.signatureHex);
  const hashType = bytes[bytes.length - 1];
  if (hashType !== SIGHASH.SINGLE_ANYONECANPAY) return false;
  const prev = btc.OutScript.decode(scripts[inputIndex]);

  if (sig.kind === 'schnorr') {
    if (prev.type !== 'tr' || bytes.length !== 65) return false;
    const msg = tx.preimageWitnessV1(inputIndex, scripts, hashType, amounts);
    try {
      return schnorr.verify(bytes.subarray(0, 64), msg, prev.pubkey);
    } catch { return false; }
  }
  if (sig.kind === 'ecdsa') {
    if (prev.type !== 'wpkh' || !sig.publicKeyHex) return false;
    const pub = hex.decode(sig.publicKeyHex);
    if (!equalBytes(hash160(pub), prev.hash)) return false;
    // BIP-143 scriptCode for P2WPKH is the classic P2PKH script.
    const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: prev.hash });
    const msg = tx.preimageWitnessV0(inputIndex, scriptCode, hashType, amounts[inputIndex]);
    try {
      return secp256k1.verify(bytes.subarray(0, -1), msg, pub, { prehash: false, format: 'der' });
    } catch { return false; }
  }
  return false;
}

/**
 * Check the PSBT the buyer's wallet returned against the PSBT we handed out:
 * same unsigned transaction (no input/output tampering), every input we asked
 * the buyer to sign is signed, and the whole thing finalizes into a valid raw
 * transaction. Returns the raw tx ready for broadcast.
 */
export function assembleBuyerSignedPsbt({ sessionPsbtHex, signedPsbtHex, buyerInputIndexes }) {
  const opts = { allowUnknownInputs: false, allowUnknownOutputs: false };
  const expected = btc.Transaction.fromPSBT(hex.decode(sessionPsbtHex), opts);
  let signed;
  try {
    signed = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex), opts);
  } catch (err) {
    throw new BuyerPsbtError(`Cannot parse signed PSBT: ${err.message}`);
  }
  if (hex.encode(signed.unsignedTx) !== hex.encode(expected.unsignedTx)) {
    throw new BuyerPsbtError('Signed PSBT does not match the transaction the server built');
  }

  // Merge: start from OUR copy (which carries the seller's finalScriptWitness and
  // correct witnessUtxo data) and pull only signature material from the wallet's copy.
  for (const idx of buyerInputIndexes) {
    const w = signed.getInput(idx);
    const update = {};
    if (w.finalScriptWitness?.length) update.finalScriptWitness = w.finalScriptWitness;
    else if (w.tapKeySig) update.tapKeySig = w.tapKeySig;
    else if (w.partialSig?.length) update.partialSig = w.partialSig;
    else throw new BuyerPsbtError(`Input ${idx} was not signed by the wallet`);
    expected.updateInput(idx, update, true);
  }

  for (let i = 0; i < expected.inputsLength; i++) {
    const inp = expected.getInput(i);
    if (inp.finalScriptWitness?.length) continue; // seller input, or wallet-finalized
    try {
      expected.finalizeIdx(i);
    } catch (err) {
      throw new BuyerPsbtError(`Cannot finalize input ${i}: ${err.message}`);
    }
  }
  if (!expected.isFinal) throw new BuyerPsbtError('Transaction still has unfinalized inputs');
  const raw = expected.extract();
  return {
    rawTxHex: hex.encode(raw),
    txid: expected.id,
    vsize: expected.vsize,
    fee: expected.fee,
    tx: expected,
  };
}

export class BuyerPsbtError extends Error {
  constructor(msg) { super(msg); this.name = 'BuyerPsbtError'; this.status = 400; }
}

/** Helper for tests / diagnostics: what an address's scriptPubKey looks like. */
export function scriptHexForAddress(address, network) {
  return hex.encode(decodeAddress(address, network).script);
}
