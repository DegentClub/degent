import { base64, hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { REVEAL_LOCKTIME, REVEAL_TX_VERSION } from './constants.js';

/**
 * btc-signer options for reveal PSBTs. `allowUnknownInputs` is required because the inscription
 * leaf is not a script template btc-signer knows (it finalizes it as [sig, script, controlBlock]).
 */
export const TX_OPTS = Object.freeze({
  version: REVEAL_TX_VERSION,
  lockTime: REVEAL_LOCKTIME,
  allowUnknownInputs: true,
});

export function decodePsbt(psbtBase64: string): Transaction {
  if (typeof psbtBase64 !== 'string' || psbtBase64.length === 0) throw new Error('PSBT base64 string required');
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(psbtBase64);
  } catch {
    throw new Error('PSBT is not valid base64');
  }
  return Transaction.fromPSBT(bytes, TX_OPTS);
}

export function encodePsbt(tx: Transaction): string {
  return base64.encode(tx.toPSBT());
}

/** Display-order txid of a PSBT input (btc-signer stores txid in display order). */
export function inputTxid(tx: Transaction, idx: number): string {
  const t = tx.getInput(idx).txid;
  if (!t) throw new Error(`input ${idx} has no txid`);
  return hex.encode(t);
}

/** Raw-transaction facts computed from the serialized bytes (independent of btc-signer's getter). */
export function rawFacts(tx: Transaction): { hex: string; txid: string; weight: number; vsize: number } {
  const full = tx.toBytes(true, true);
  const stripped = tx.toBytes(true, false);
  const weight = stripped.length * 3 + full.length;
  return { hex: hex.encode(full), txid: tx.id, weight, vsize: Math.ceil(weight / 4) };
}
