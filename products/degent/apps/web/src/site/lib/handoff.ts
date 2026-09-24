/**
 * Turn exact bytes (from the Atelier or the user's file) into the mint's `Artwork`. Nothing is
 * re-encoded: the bytes object handed to the mint is these bytes, and the SHA-256 is computed here
 * with the mint SDK (one implementation).
 */
import { readImageInfo, sha256Hex, sniffContentType, tierForSize, type Tier } from '@bsh/degent-mint-sdk';
import type { Artwork } from '../../flow/state';

export interface Measured {
  artwork: Artwork;
  /** The tier the byte count falls in, or null (then it cannot be minted as is). */
  tier: Tier | null;
}

export function measureBytes(bytes: Uint8Array, fileName: string): Measured {
  const info = readImageInfo(bytes);
  const contentType = info?.contentType ?? sniffContentType(bytes) ?? 'application/octet-stream';
  const artwork: Artwork = {
    fileName,
    bytes,
    contentType,
    size: bytes.length,
    width: info?.width ?? 0,
    height: info?.height ?? 0,
    sha256: sha256Hex(bytes),
    origin: 'original',
  };
  return { artwork, tier: tierForSize(bytes.length)?.tier ?? null };
}

export class HashMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`The Atelier sent bytes whose SHA-256 (${actual.slice(0, 12)}…) does not match the finalised hash (${expected.slice(0, 12)}…). Refusing to mint them.`);
    this.name = 'HashMismatchError';
  }
}

/** Measure bytes fetched by content hash and refuse them unless the hash matches. */
export function verifyContent(bytes: Uint8Array, expectedSha256: string, fileName: string): Measured {
  const m = measureBytes(bytes, fileName);
  if (m.artwork.sha256 !== expectedSha256) throw new HashMismatchError(expectedSha256, m.artwork.sha256);
  return m;
}
