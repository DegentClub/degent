/**
 * Seller side of settlement: the listing template PSBT and extraction of the seller's signature.
 *
 * Final transaction layout (docs/SETTLEMENT.md):
 *
 *   inputs                              outputs
 *   0  buyer padding #1  (≥600 sats)    0  padding merge    → buyer
 *   1  buyer padding #2  (≥600 sats)    1  postage (insc.)  → buyer   ← inscription sat lands here
 *   2  INSCRIPTION UTXO  (seller)       2  price            → seller  ← the only output the seller signs
 *   3+ buyer payment UTXO(s)            3  royalty          → treasury (when ROYALTY_BPS > 0)
 *                                       4  change           → buyer   (omitted when dust)
 *
 * The seller signs input #2 with SIGHASH_SINGLE|ANYONECANPAY (0x83): the signature commits to their own
 * input (outpoint, amount, script, sequence) and to output #2 only. BIP341 also commits to the input
 * index for taproot, so the seller must sign at the index the inscription will occupy: 2. The template's
 * inputs/outputs 0 and 1 are placeholders (zero txid, 600 sats to the seller's own script) that are never
 * signed or broadcast; wallets need witness_utxo on every input to compute a taproot sighash.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { Network } from '@bsh/inscription';
import { DUMMY_COUNT, INSCRIPTION_INPUT_INDEX, PRICE_OUTPUT_INDEX, SIGHASH_SINGLE_ANYONECANPAY } from '@bsh/degent-market-sdk';
import { SettlementError } from '../errors.js';
import { STRICT_TX, decodeAddress, encodePsbt, parsePsbt, paymentForOwner } from './addresses.js';

export const PLACEHOLDER_TXID = '00'.repeat(32);
export const PLACEHOLDER_VALUE = 600n;
export const SELLER_SIGHASH = SIGHASH_SINGLE_ANYONECANPAY;

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint | number;
}

export interface SellerSignature {
  kind: 'schnorr' | 'ecdsa';
  /** Signature incl. the trailing sighash byte (0x83). */
  signatureHex: string;
  /** P2WPKH only: the 33-byte compressed key from the witness. */
  publicKeyHex?: string;
}

export interface SellerTemplate {
  psbtHex: string;
  psbtBase64: string;
  unsignedTxHex: string;
  signIndex: typeof INSCRIPTION_INPUT_INDEX;
  sighashType: typeof SELLER_SIGHASH;
}

export interface SellerTemplateArgs {
  inscriptionUtxo: Utxo;
  sellerAddress: string;
  sellerPublicKey: string;
  priceSats: bigint | number;
  network: Network;
}

export function buildSellerTemplate(a: SellerTemplateArgs): SellerTemplate {
  const owner = paymentForOwner(a.sellerAddress, a.sellerPublicKey, a.network);
  const price = BigInt(a.priceSats);
  const postage = BigInt(a.inscriptionUtxo.value);
  if (price <= 0n) throw new SettlementError('validation_failed', 'price must be positive');
  if (postage <= 0n) throw new SettlementError('validation_failed', 'inscription UTXO value must be positive');

  const tx = new btc.Transaction(STRICT_TX);
  for (let i = 0; i < DUMMY_COUNT; i++)
    tx.addInput({ txid: PLACEHOLDER_TXID, index: i, sequence: 0xffffffff, witnessUtxo: { amount: PLACEHOLDER_VALUE, script: owner.script } });
  tx.addInput({
    txid: a.inscriptionUtxo.txid,
    index: a.inscriptionUtxo.vout,
    sequence: 0xffffffff,
    witnessUtxo: { amount: postage, script: owner.script },
    sighashType: SELLER_SIGHASH,
    ...(owner.tapInternalKey ? { tapInternalKey: owner.tapInternalKey } : {}),
  });
  for (let i = 0; i < DUMMY_COUNT; i++) tx.addOutput({ script: owner.script, amount: PLACEHOLDER_VALUE });
  tx.addOutput({ script: owner.script, amount: price });
  return { ...encodePsbt(tx), unsignedTxHex: hex.encode(tx.unsignedTx), signIndex: INSCRIPTION_INPUT_INDEX, sighashType: SELLER_SIGHASH };
}

export interface ExtractExpectations {
  unsignedTxHex: string;
  inscriptionUtxo: Utxo;
  sellerAddress: string;
  priceSats: bigint | number;
  network: Network;
}

/**
 * Pull the seller's signature out of the PSBT the wallet returned and check it is structurally what we
 * asked for (same unsigned transaction, input #2 = the listed outpoint, output #2 = price to the seller,
 * sighash 0x83). Cryptographic verification is `verifyInputSignature`, against the template and again
 * against the real purchase.
 */
export function extractSellerSignature(signedPsbt: string | Uint8Array, expected?: ExtractExpectations): SellerSignature {
  const tx = parsePsbt(signedPsbt, { allowUnknownInputs: true, allowUnknownOutputs: true });
  if (tx.inputsLength !== DUMMY_COUNT + 1 || tx.outputsLength !== DUMMY_COUNT + 1)
    throw new SettlementError('bad_psbt', 'signed PSBT does not have the 3-input / 3-output listing layout');
  if (expected && hex.encode(tx.unsignedTx) !== expected.unsignedTxHex)
    throw new SettlementError('bad_psbt', 'signed PSBT does not match the transaction the service built');
  const input = tx.getInput(INSCRIPTION_INPUT_INDEX);
  const out = tx.getOutput(PRICE_OUTPUT_INDEX);
  if (expected) {
    if (!input.txid || hex.encode(input.txid) !== expected.inscriptionUtxo.txid || input.index !== expected.inscriptionUtxo.vout)
      throw new SettlementError('bad_psbt', 'input #2 is not the listed inscription outpoint');
    const sellerScript = decodeAddress(expected.sellerAddress, expected.network).script;
    if (!out.script || hex.encode(out.script) !== hex.encode(sellerScript) || out.amount !== BigInt(expected.priceSats))
      throw new SettlementError('bad_psbt', 'output #2 is not the price paid to the seller');
  }

  // Taproot key path: tapKeySig (partial) or a 1-element finalScriptWitness.
  let sig: Uint8Array | undefined;
  if (input.tapKeySig) sig = input.tapKeySig;
  else if (input.finalScriptWitness?.length === 1) sig = input.finalScriptWitness[0];
  if (sig) {
    if (sig.length !== 65) throw new SettlementError('bad_seller_signature', `expected a 65-byte Schnorr signature with a sighash byte, got ${sig.length} bytes`);
    if (sig[64] !== SELLER_SIGHASH) throw new SettlementError('bad_seller_signature', `expected sighash 0x83 (SINGLE|ANYONECANPAY), got 0x${sig[64]!.toString(16)}`);
    return { kind: 'schnorr', signatureHex: hex.encode(sig) };
  }

  // Native segwit (P2WPKH): partialSig [[pubkey, sig]] or finalScriptWitness [sig, pubkey].
  let pair: [Uint8Array, Uint8Array] | undefined;
  if (input.partialSig?.length) pair = input.partialSig[0] as [Uint8Array, Uint8Array];
  else if (input.finalScriptWitness?.length === 2) pair = [input.finalScriptWitness[1]!, input.finalScriptWitness[0]!];
  if (pair) {
    const [pub, s] = pair;
    if (s[s.length - 1] !== SELLER_SIGHASH) throw new SettlementError('bad_seller_signature', 'expected sighash 0x83 on the ECDSA signature');
    return { kind: 'ecdsa', signatureHex: hex.encode(s), publicKeyHex: hex.encode(pub) };
  }
  throw new SettlementError('bad_seller_signature', 'no signature found on input #2');
}
