/**
 * Header-only image sniffing (magic bytes + dimensions). Independent of any raster library so the
 * review can be trusted even if the compositor's decoder were fooled. Never touches pixel data.
 */
export interface ImageInfo {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif';
  width: number | null;
  height: number | null;
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export function readImageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 12) return null;
  // PNG
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (b.length >= 24 && ascii(b, 12, 4) === 'IHDR') return { contentType: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
    return { contentType: 'image/png', width: null, height: null };
  }
  // JPEG: walk segments to the first SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      if (marker === 0xff) {
        o++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = u16be(b, o + 2);
      const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (o + 9 > b.length) break;
        return { contentType: 'image/jpeg', width: u16be(b, o + 7), height: u16be(b, o + 5) };
      }
      if (len < 2) break;
      o += 2 + len;
    }
    return { contentType: 'image/jpeg', width: null, height: null };
  }
  // GIF
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { contentType: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
  // WebP
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' && b.length >= 30) {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ') return { contentType: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { contentType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { contentType: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return { contentType: 'image/webp', width: null, height: null };
  }
  // AVIF (ftyp box with avif/avis brand). Dimensions live in ispe deep inside meta; not parsed here.
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { contentType: 'image/avif', width: null, height: null };
  }
  return null;
}
