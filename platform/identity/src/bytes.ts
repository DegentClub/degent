import { base64, base64urlnopad } from '@scure/base';

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);

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

/** Plain (short-circuit) equality. Use only for public data. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Bitcoin CompactSize (varint). */
export function compactSize(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`compactSize: invalid ${n}`);
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  throw new Error('compactSize: > 2^32 not supported');
}

/** CompactSize length prefix followed by the bytes. */
export const varBytes = (b: Uint8Array): Uint8Array => concatBytes(compactSize(b.length), b);

export function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

export function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

/** Strict standard base64 (with padding). Throws on anything else. */
export function decodeBase64(s: string): Uint8Array {
  return base64.decode(s.trim());
}
export const encodeBase64 = (b: Uint8Array): string => base64.encode(b);

/** RFC 7515 base64url without padding (strict). */
export const b64url = {
  encode: (b: Uint8Array): string => base64urlnopad.encode(b),
  decode: (s: string): Uint8Array => base64urlnopad.decode(s),
};

/** Minimal cursor over a byte array for consensus decoding. */
export class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('unexpected end of data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8(): number {
    return this.bytes(1)[0]!;
  }
  compactSize(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const b = this.bytes(2);
      const n = b[0]! | (b[1]! << 8);
      if (n < 0xfd) throw new Error('non-canonical compactSize');
      return n;
    }
    if (first === 0xfe) {
      const b = this.bytes(4);
      const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
      if (n <= 0xffff) throw new Error('non-canonical compactSize');
      return n;
    }
    throw new Error('compactSize > 2^32 not supported');
  }
}
