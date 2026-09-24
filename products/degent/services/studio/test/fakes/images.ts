/** Tiny but structurally real image headers for tests, with optional padding to hit a size. */

const enc = (s: string) => new TextEncoder().encode(s);

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const td = concat([enc(type), data]);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(td));
  return concat([len, td, crc]);
}

function filler(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(Math.max(0, n));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export function png(width: number, height: number, totalBytes?: number, seed = 7): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const head = concat([sig, pngChunk('IHDR', ihdr)]);
  const iend = pngChunk('IEND', new Uint8Array(0));
  const base = head.length + iend.length;
  if (totalBytes === undefined || totalBytes <= base + 12) return concat([head, iend]);
  return concat([head, pngChunk('deGt', filler(totalBytes - base - 12, seed)), iend]);
}

export function jpeg(width: number, height: number, totalBytes?: number, seed = 7): Uint8Array {
  const soi = new Uint8Array([0xff, 0xd8]);
  const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x10, ...enc('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = new Uint8Array([0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const eoi = new Uint8Array([0xff, 0xd9]);
  const parts = [soi, app0];
  let size = soi.length + app0.length + sof.length + eoi.length;
  if (totalBytes !== undefined) {
    let remaining = totalBytes - size;
    while (remaining >= 4) {
      const payload = Math.min(remaining - 4, 65533);
      const seg = new Uint8Array(4 + payload);
      seg[0] = 0xff;
      seg[1] = 0xfe; // COM
      seg[2] = (payload + 2) >> 8;
      seg[3] = (payload + 2) & 0xff;
      seg.set(filler(payload, seed), 4);
      parts.push(seg);
      remaining -= seg.length;
      size += seg.length;
    }
  }
  return concat([...parts, sof, eoi]);
}

export function gif(width: number, height: number, totalBytes?: number): Uint8Array {
  const b = new Uint8Array(Math.max(13, totalBytes ?? 13));
  b.set(enc('GIF89a'), 0);
  b.set([width & 0xff, width >> 8, height & 0xff, height >> 8], 6);
  return b;
}

export function avif(width: number, height: number, totalBytes?: number): Uint8Array {
  const ftyp = new Uint8Array([0, 0, 0, 20, ...enc('ftyp'), ...enc('avif'), 0, 0, 0, 0, ...enc('mif1')]);
  const ispe = new Uint8Array(20);
  const dv = new DataView(ispe.buffer);
  dv.setUint32(0, 20);
  ispe.set(enc('ispe'), 4);
  dv.setUint32(12, width);
  dv.setUint32(16, height);
  const head = concat([ftyp, ispe]);
  if (totalBytes === undefined || totalBytes <= head.length) return head;
  return concat([head, filler(totalBytes - head.length)]);
}

/** A rule-compliant Standard Degent: square JPEG, 1024 px, 250 KB. */
export function squareArt(size = 250_000, side = 1024, seed = 7): Uint8Array {
  return jpeg(side, side, size, seed);
}
