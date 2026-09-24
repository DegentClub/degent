/**
 * Small JPEG byte helpers for the demo Atelier (no network, no server compositor):
 * - `padJpeg` grows a real JPEG to an exact byte count with COM (comment) segments inserted after
 *   SOI. Decoders ignore COM segments, so the picture is unchanged and still decodes.
 * - `syntheticJpeg` builds header-only JPEG bytes (SOI, APP0, SOF0 with the given dimensions, COM
 *   padding, a stub SOS, EOI) for jsdom tests, where no canvas encoder exists. It is parseable by
 *   `readImageInfo` but is not a displayable picture.
 */

const COM_MAX = 0xffff + 2; // one COM segment: FF FE + u16 length (<= 65535, counts itself) + data

function comSegments(total: number, seed: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  let x = seed >>> 0 || 1;
  let remaining = total;
  while (remaining > 0) {
    let chunk = Math.min(remaining, COM_MAX);
    if (remaining - chunk > 0 && remaining - chunk < 4) chunk = remaining - 4;
    const len = chunk - 2;
    out[o] = 0xff;
    out[o + 1] = 0xfe;
    out[o + 2] = len >> 8;
    out[o + 3] = len & 0xff;
    for (let i = 4; i < chunk; i++) {
      // xorshift noise, never 0xFF (keeps the data from looking like a marker to naive scanners)
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[o + i] = (x >>> 0) % 0xff;
    }
    o += chunk;
    remaining -= chunk;
  }
  return out;
}

/** Grow `jpeg` to exactly `target` bytes. Returns null when that is impossible (smaller, or < 4 bytes to add). */
export function padJpeg(jpeg: Uint8Array, target: number, seed = 7): Uint8Array | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const add = target - jpeg.length;
  if (add === 0) return jpeg;
  if (add < 4) return null;
  // Insert after SOI, or after the APP0 (JFIF) segment when present, so JFIF stays first.
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0 && jpeg.length >= 6) at = 4 + ((jpeg[4]! << 8) | jpeg[5]!);
  if (at > jpeg.length) at = 2;
  const out = new Uint8Array(target);
  out.set(jpeg.subarray(0, at), 0);
  out.set(comSegments(add, seed), at);
  out.set(jpeg.subarray(at), at + add);
  return out;
}

/** Header-only JPEG of exactly `size` bytes whose SOF0 declares `width` x `height`. */
export function syntheticJpeg(width: number, height: number, size: number, seed = 1): Uint8Array {
  const head = [
    0xff, 0xd8,
    // APP0 JFIF
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // SOF0: len 17, precision 8, height, width, 3 components
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    // SOS stub
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  ];
  const tail = [0x00, 0xff, 0xd9];
  const base = new Uint8Array(head.length + tail.length);
  base.set(head, 0);
  base.set(tail, head.length);
  const padded = padJpeg(base, size, seed);
  if (!padded) throw new Error(`cannot build a ${size}-byte JPEG`);
  return padded;
}
