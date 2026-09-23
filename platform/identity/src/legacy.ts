/**
 * Legacy "Bitcoin Signed Message" (Bitcoin Core `signmessage`, BIP-137 header bytes): a 65-byte
 * recoverable compact ECDSA signature, base64. Still produced by many wallets for P2PKH and
 * P2WPKH (and P2SH-P2WPKH) addresses.
 *
 * digest = sha256d(varstr("Bitcoin Signed Message:\n") || varstr(message))
 * header = 27 + recid (+4 compressed P2PKH) | 35 + recid (P2SH-P2WPKH) | 39 + recid (P2WPKH)
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concatBytes, decodeBase64, encodeBase64, equalBytes, utf8, varBytes } from './bytes.js';
import { hash160, sha256d } from './bip322.js';
import { decodeAddress, type DecodedAddress } from './address.js';
import type { BitcoinNetwork } from './network.js';

const MAGIC = utf8('Bitcoin Signed Message:\n');

export function legacyMessageHash(message: string | Uint8Array): Uint8Array {
  const m = typeof message === 'string' ? utf8(message) : message;
  return sha256d(concatBytes(varBytes(MAGIC), varBytes(m)));
}

/** True when a decoded signature looks like a BIP-137 compact signature (65 bytes, header 27..42). */
export function isLegacySignature(raw: Uint8Array): boolean {
  return raw.length === 65 && raw[0]! >= 27 && raw[0]! <= 42;
}

export type LegacyResult = { valid: true; kind: 'p2pkh' | 'p2wpkh' | 'p2sh-p2wpkh' } | { valid: false; reason: string };

export function verifyLegacyDecoded(decoded: DecodedAddress, message: string | Uint8Array, signatureBase64: string): LegacyResult {
  let raw: Uint8Array;
  try {
    raw = decodeBase64(signatureBase64);
  } catch {
    return { valid: false, reason: 'malformed signature: not base64' };
  }
  if (!isLegacySignature(raw)) return { valid: false, reason: 'legacy: expected 65-byte compact signature' };
  const header = raw[0]!;
  const recid = (header - 27) & 3;
  const compressed = header >= 31;
  try {
    const recovered = Uint8Array.from([recid, ...raw.subarray(1)]);
    const point = secp256k1.Point.fromBytes(
      secp256k1.recoverPublicKey(recovered, legacyMessageHash(message), { prehash: false }),
    );
    const pubkey = point.toBytes(compressed);
    const h = hash160(pubkey);
    switch (decoded.kind) {
      case 'p2pkh':
        return equalBytes(h, decoded.program) ? { valid: true, kind: 'p2pkh' } : { valid: false, reason: 'legacy: key does not match address' };
      case 'p2wpkh':
        if (!compressed) return { valid: false, reason: 'legacy: segwit requires a compressed key' };
        return equalBytes(h, decoded.program) ? { valid: true, kind: 'p2wpkh' } : { valid: false, reason: 'legacy: key does not match address' };
      case 'p2sh': {
        if (!compressed) return { valid: false, reason: 'legacy: segwit requires a compressed key' };
        const redeem = concatBytes(Uint8Array.of(0x00, 0x14), h);
        return equalBytes(hash160(redeem), decoded.program)
          ? { valid: true, kind: 'p2sh-p2wpkh' }
          : { valid: false, reason: 'legacy: key does not match address' };
      }
      default:
        // A P2TR output key is tweaked; an ECDSA signature by the internal key proves nothing about it.
        return { valid: false, reason: `legacy signatures are not accepted for ${decoded.kind} addresses` };
    }
  } catch (e) {
    return { valid: false, reason: `legacy: ${(e as Error).message}` };
  }
}

export function verifyLegacyMessage(
  address: string,
  network: BitcoinNetwork,
  message: string | Uint8Array,
  signatureBase64: string,
): LegacyResult {
  let decoded: DecodedAddress;
  try {
    decoded = decodeAddress(address, network);
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }
  return verifyLegacyDecoded(decoded, message, signatureBase64);
}

/** Reference legacy signer (tests / tooling). `kind` selects the BIP-137 header. */
export function signLegacyMessage(
  privateKey: Uint8Array,
  message: string | Uint8Array,
  kind: 'p2pkh' | 'p2pkh-uncompressed' | 'p2wpkh' | 'p2sh-p2wpkh' = 'p2wpkh',
): string {
  const sig = secp256k1.sign(legacyMessageHash(message), privateKey, { prehash: false, lowS: true, format: 'recovered' });
  const recid = sig[0]!;
  const base = { 'p2pkh-uncompressed': 27, p2pkh: 31, 'p2sh-p2wpkh': 35, p2wpkh: 39 }[kind];
  return encodeBase64(concatBytes(Uint8Array.of(base + recid), sig.subarray(1)));
}
