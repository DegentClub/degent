/**
 * Minimal image header parser: detects the real format from magic bytes and reads pixel
 * dimensions for PNG, JPEG, WebP (VP8 / VP8L / VP8X), GIF and AVIF (ispe box).
 * It never decodes pixel data, so it is cheap on 4 MB inputs and safe on hostile bytes:
 * every read is bounds-checked and malformed input yields `null`, never an exception.
 */

export interface ImageInfo {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif';
  width: number | null;
  height: number | null;
}

const ascii = (b: Uint8Array, off: number, len: number): string => {
  if (off < 0 || off + len > b.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]!);
  return s;
};
const u16be = (b: Uint8Array, o: number) => (o + 2 <= b.length ? (b[o]! << 8) | b[o + 1]! : -1);
const u16le = (b: Uint8Array, o: number) => (o + 2 <= b.length ? b[o]! | (b[o + 1]! << 8) : -1);
const u24le = (b: Uint8Array, o: number) => (o + 3 <= b.length ? b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) : -1);
const u32be = (b: Uint8Array, o: number) =>
  o + 4 <= b.length ? ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]! : -1;

/** Detect the format from magic bytes (ignores whatever the client declared). */
export function sniffContentType(b: Uint8Array): ImageInfo['contentType'] | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  const gif = ascii(b, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (ascii(b, 4, 4) === 'ftyp') {
    const size = u32be(b, 0);
    const end = Math.min(b.length, size > 0 ? size : 32);
    for (let o = 8; o + 4 <= end; o += 4) {
      const brand = ascii(b, o, 4);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
  }
  return null;
}

function png(b: Uint8Array): [number, number] | null {
  // signature(8) + length(4) + "IHDR" + width(4) + height(4)
  if (ascii(b, 12, 4) !== 'IHDR') return null;
  const w = u32be(b, 16);
  const h = u32be(b, 20);
  return w > 0 && h > 0 ? [w, h] : null;
}

function jpeg(b: Uint8Array): [number, number] | null {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    let marker = b[o + 1]!;
    // fill bytes
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const h = u16be(b, o + 5);
      const w = u16be(b, o + 7);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    o += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array): [number, number] | null {
  const chunk = ascii(b, 12, 4);
  const d = 20; // chunk payload start
  if (chunk === 'VP8 ') {
    // frame tag(3) + start code 9d 01 2a + w(2) + h(2), 14-bit values
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
    const w = u16le(b, d + 6) & 0x3fff;
    const h = u16le(b, d + 8) & 0x3fff;
    return w > 0 && h > 0 ? [w, h] : null;
  }
  if (chunk === 'VP8L') {
    if (b[d] !== 0x2f || d + 5 > b.length) return null;
    const b1 = b[d + 1]!, b2 = b[d + 2]!, b3 = b[d + 3]!, b4 = b[d + 4]!;
    const w = 1 + (((b2 & 0x3f) << 8) | b1);
    const h = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return [w, h];
  }
  if (chunk === 'VP8X') {
    const w = u24le(b, d + 4);
    const h = u24le(b, d + 7);
    return w >= 0 && h >= 0 ? [w + 1, h + 1] : null;
  }
  return null;
}

function gif(b: Uint8Array): [number, number] | null {
  const w = u16le(b, 6);
  const h = u16le(b, 8);
  return w > 0 && h > 0 ? [w, h] : null;
}

function avif(b: Uint8Array): [number, number] | null {
  // Find the first 'ispe' property box (size(4) 'ispe' version+flags(4) width(4) height(4)).
  const limit = Math.min(b.length, 1 << 16);
  for (let o = 4; o + 16 <= limit; o++) {
    if (b[o] === 0x69 && ascii(b, o, 4) === 'ispe') {
      const w = u32be(b, o + 8);
      const h = u32be(b, o + 12);
      return w > 0 && h > 0 ? [w, h] : null;
    }
  }
  return null;
}

/** Real format + dimensions, or null when the bytes are not a recognised image. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const contentType = sniffContentType(bytes);
  if (!contentType) return null;
  const dims =
    contentType === 'image/png'
      ? png(bytes)
      : contentType === 'image/jpeg'
        ? jpeg(bytes)
        : contentType === 'image/webp'
          ? webp(bytes)
          : contentType === 'image/gif'
            ? gif(bytes)
            : avif(bytes);
  return { contentType, width: dims?.[0] ?? null, height: dims?.[1] ?? null };
}
