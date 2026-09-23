// Seller side of settlement: the listing PSBT.
//
// Final transaction layout (see docs/SETTLEMENT.md):
//
//   inputs                              outputs
//   0  buyer dummy #1  (≥600 sats)      0  dummy merge      → buyer
//   1  buyer dummy #2  (≥600 sats)      1  postage (insc.)  → buyer   ← inscription sat lands here
//   2  INSCRIPTION UTXO (seller)        2  price            → seller  ← the only output the seller signs
//   3+ buyer payment UTXO(s)            3  royalty          → treasury (optional)
//                                       4  change           → buyer
//
// WHY INDEX 2
// The seller signs with SIGHASH_SINGLE | ANYONECANPAY. That commits to exactly
// one input (theirs) and the output with the SAME index. BIP-341 additionally
// commits to the input's *index* for taproot spends, so the seller must sign at
// the index it will occupy in the final transaction. Index 0 is impossible
// (the price output would then be output 0 and, under FIFO, receive the
// inscription sat — the original bug). Index 1 would require the inscription
// output to sit at index 0 with a single dummy before it. Index 2 with two
// dummy inputs gives:
//   * outputs 0 and 1 are both "before" the price output, so the buyer controls
//     everything the inscription sat can land in;
//   * output 0 (the merged dummies, ≥1200 sats) absorbs any dust-rounding and
//     can be split back into fresh dummies for the next purchase;
//   * the layout matches the index-2 convention used by the major ordinals
//     marketplaces, so third-party tooling can reason about it.
//
// The two placeholder inputs/outputs in the seller PSBT are never spent or
// broadcast: ANYONECANPAY|SINGLE does not commit to them, they only exist so
// the signer sees a structurally valid transaction with the inscription at
// index 2. Wallets DO need witness_utxo on every input to compute the taproot
// sighash, so the placeholders carry a small self-referencing witness_utxo.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { paymentForOwner, decodeAddress, SIGHASH } from './addresses.js';

export const INSCRIPTION_INPUT_INDEX = 2;
export const PRICE_OUTPUT_INDEX = 2;
export const DUMMY_COUNT = 2;
export const PLACEHOLDER_TXID = '00'.repeat(32);
export const PLACEHOLDER_VALUE = 600n;
export const SELLER_SIGHASH = SIGHASH.SINGLE_ANYONECANPAY;

/**
 * Build the PSBT the seller signs to list an inscription.
 *
 * @param {object} p
 * @param {{txid:string, vout:number, value:number|bigint}} p.inscriptionUtxo
 * @param {string} p.sellerAddress        address holding the inscription; receives the price
 * @param {string} p.sellerPublicKey      33-byte compressed pubkey hex (from wallet.getPublicKey)
 * @param {number|bigint} p.priceSats
 * @param {import('@scure/btc-signer').BTC_NETWORK} p.network
 * @returns {{psbtHex:string, psbtBase64:string, signIndex:number, sighashType:number, unsignedTxHex:string}}
 */
export function buildSellerPsbt({ inscriptionUtxo, sellerAddress, sellerPublicKey, priceSats, network }) {
  const owner = paymentForOwner(sellerAddress, sellerPublicKey, network);
  const price = BigInt(priceSats);
  const postage = BigInt(inscriptionUtxo.value);
  if (price <= 0n) throw new Error('price must be positive');
  if (postage <= 0n) throw new Error('inscription UTXO value must be positive');

  const tx = new btc.Transaction({ allowUnknownInputs: false, allowUnknownOutputs: false });

  // 0, 1: placeholders — replaced by the buyer's dummy UTXOs in the final tx.
  for (let i = 0; i < DUMMY_COUNT; i++) {
    tx.addInput({
      txid: PLACEHOLDER_TXID,
      index: i,
      sequence: 0xffffffff,
      witnessUtxo: { amount: PLACEHOLDER_VALUE, script: owner.script },
    });
  }
  // 2: the inscription being sold.
  const inscriptionInput = {
    txid: inscriptionUtxo.txid,
    index: inscriptionUtxo.vout,
    sequence: 0xffffffff,
    witnessUtxo: { amount: postage, script: owner.script },
    sighashType: SELLER_SIGHASH,
  };
  if (owner.type === 'tr') inscriptionInput.tapInternalKey = owner.tapInternalKey;
  tx.addInput(inscriptionInput);

  // Outputs 0, 1: placeholders. Output 2: the seller's price — the only output the signature commits to.
  for (let i = 0; i < DUMMY_COUNT; i++) tx.addOutput({ script: owner.script, amount: PLACEHOLDER_VALUE });
  tx.addOutput({ script: owner.script, amount: price });

  const psbt = tx.toPSBT();
  return {
    psbtHex: hex.encode(psbt),
    psbtBase64: Buffer.from(psbt).toString('base64'),
    signIndex: INSCRIPTION_INPUT_INDEX,
    sighashType: SELLER_SIGHASH,
    unsignedTxHex: hex.encode(tx.unsignedTx),
  };
}

/**
 * Pull the seller's signature out of the PSBT the wallet returned and check it
 * is structurally what we asked for. Cryptographic verification happens in
 * verify.js against the exact final transaction.
 *
 * @returns {{signatureHex:string, kind:'schnorr'|'ecdsa', publicKeyHex?:string}}
 */
export function extractSellerSignature(signedPsbtHex, expected) {
  let tx;
  try {
    tx = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  } catch (err) {
    throw new SellerPsbtError(`Cannot parse signed PSBT: ${err.message}`);
  }
  if (tx.inputsLength !== DUMMY_COUNT + 1 || tx.outputsLength !== DUMMY_COUNT + 1) {
    throw new SellerPsbtError('Signed PSBT does not have the 3-input / 3-output listing layout');
  }
  if (expected?.unsignedTxHex && hex.encode(tx.unsignedTx) !== expected.unsignedTxHex) {
    throw new SellerPsbtError('Signed PSBT does not match the transaction the server built');
  }
  const input = tx.getInput(INSCRIPTION_INPUT_INDEX);
  const out = tx.getOutput(PRICE_OUTPUT_INDEX);

  if (expected) {
    const { inscriptionUtxo, sellerAddress, priceSats, network } = expected;
    const inTxid = hex.encode(input.txid);
    if (inTxid !== inscriptionUtxo.txid || input.index !== inscriptionUtxo.vout) {
      throw new SellerPsbtError('Input #2 is not the listed inscription outpoint');
    }
    const sellerScript = decodeAddress(sellerAddress, network).script;
    if (hex.encode(out.script) !== hex.encode(sellerScript) || out.amount !== BigInt(priceSats)) {
      throw new SellerPsbtError('Output #2 is not the price paid to the seller');
    }
  }

  // Taproot key-path: tapKeySig (partial) or a 1-element finalScriptWitness.
  let sig;
  if (input.tapKeySig) sig = input.tapKeySig;
  else if (input.finalScriptWitness?.length === 1) sig = input.finalScriptWitness[0];
  if (sig) {
    if (sig.length !== 65) throw new SellerPsbtError(`Expected a 65-byte Schnorr signature with sighash byte, got ${sig.length} bytes`);
    if (sig[64] !== SELLER_SIGHASH) throw new SellerPsbtError(`Expected sighash 0x83 (SINGLE|ANYONECANPAY), got 0x${sig[64].toString(16)}`);
    return { signatureHex: hex.encode(sig), kind: 'schnorr' };
  }

  // Native segwit (P2WPKH): partialSig [[pubkey, sig]] or finalScriptWitness [sig, pubkey].
  let pair;
  if (input.partialSig?.length) pair = input.partialSig[0];
  else if (input.finalScriptWitness?.length === 2) pair = [input.finalScriptWitness[1], input.finalScriptWitness[0]];
  if (pair) {
    const [pub, s] = pair;
    if (s[s.length - 1] !== SELLER_SIGHASH) throw new SellerPsbtError('Expected sighash 0x83 on the ECDSA signature');
    return { signatureHex: hex.encode(s), kind: 'ecdsa', publicKeyHex: hex.encode(pub) };
  }
  throw new SellerPsbtError('No signature found on input #2');
}

export class SellerPsbtError extends Error {
  constructor(msg) { super(msg); this.name = 'SellerPsbtError'; this.status = 400; }
}
