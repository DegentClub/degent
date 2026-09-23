import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';

export { bytesToHex };

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/** BIP340-style tagged hash: sha256(sha256(tag) || sha256(tag) || msg). */
export function taggedHash(tag: string, msg: Uint8Array | string): Uint8Array {
  const t = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(t, t, typeof msg === 'string' ? utf8ToBytes(msg) : msg));
}
