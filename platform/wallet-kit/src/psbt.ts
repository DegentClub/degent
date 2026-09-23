import { base64, hex } from '@scure/base';
import { WalletError } from './errors.js';

/** "psbt" + 0xff (BIP-174). */
const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

function hasMagic(bytes: Uint8Array): boolean {
  return bytes.length > PSBT_MAGIC.length && PSBT_MAGIC.every((b, i) => bytes[i] === b);
}

function invalid(msg: string, cause?: unknown): WalletError {
  return new WalletError('INVALID_PSBT', msg, cause === undefined ? {} : { cause });
}

export function psbtBase64ToBytes(psbtBase64: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(psbtBase64.trim());
  } catch (e) {
    throw invalid('PSBT is not valid base64.', e);
  }
  if (!hasMagic(bytes)) throw invalid('Not a PSBT (missing "psbt\\xff" magic).');
  return bytes;
}

export function psbtHexToBytes(psbtHex: string): Uint8Array {
  const clean = psbtHex.trim().replace(/^0x/i, '').toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = hex.decode(clean);
  } catch (e) {
    throw invalid('PSBT is not valid hex.', e);
  }
  if (!hasMagic(bytes)) throw invalid('Not a PSBT (missing "psbt\\xff" magic).');
  return bytes;
}

/** base64 → lowercase hex (UniSat, OKX, Leather want hex). Validates the PSBT magic. */
export function psbtBase64ToHex(psbtBase64: string): string {
  return hex.encode(psbtBase64ToBytes(psbtBase64));
}

/** hex → base64 (the kit's canonical form). Validates the PSBT magic. */
export function psbtHexToBase64(psbtHex: string): string {
  return base64.encode(psbtHexToBytes(psbtHex));
}

/** Re-encodes a base64 PSBT canonically after validating it. */
export function normalizePsbtBase64(psbtBase64: string): string {
  return base64.encode(psbtBase64ToBytes(psbtBase64));
}
