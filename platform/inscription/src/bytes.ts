import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Bitcoin CompactSize (varint) encoded length. */
export function compactSizeLen(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

export function compactSize(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`compactSize: invalid ${n}`);
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  throw new Error('compactSize: > 2^32 not supported');
}

export function u32le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

export function i32le(n: number): Uint8Array {
  return u32le(n >>> 0);
}

export function u64le(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`u64: out of range ${n}`);
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Display-order (big-endian hex) txid -> internal byte order. */
export function txidToInternal(txid: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`invalid txid: ${txid}`);
  return hex.decode(txid.toLowerCase()).reverse();
}

export function internalToTxid(bytes: Uint8Array): string {
  return hex.encode(Uint8Array.from(bytes).reverse());
}

export function sha256Hex(bytes: Uint8Array): string {
  return hex.encode(sha256(bytes));
}

export function assertBytes(b: unknown, len: number | undefined, name: string): asserts b is Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (len !== undefined && b.length !== len) throw new Error(`${name} must be ${len} bytes, got ${b.length}`);
}
