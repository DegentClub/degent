/**
 * JPEG size targeting on REAL encoder output: binary search on quality, measuring the bytes `canvas.toBlob`
 * actually returns (never an estimate), until the file is as large as possible without exceeding the target,
 * inside the tier bounds from @bsh/degent-mint-sdk. Ported from the hardened combiner
 * (degen-frame-combiner `findQualityForTargetSize`), with the tier range as a hard constraint.
 */

export interface SizeTarget {
  /** Tier bounds (inclusive), from the collection config. */
  minBytes: number;
  maxBytes: number;
  /** Where the user put the slider; clamped into [minBytes, maxBytes]. */
  targetBytes: number;
}

export interface SizeAttempt {
  quality: number;
  size: number;
}

export type SizeSearchStatus = 'fit' | 'too-small' | 'too-large' | 'no-fit';

export interface SizeSearchResult {
  status: SizeSearchStatus;
  blob: Blob;
  quality: number;
  size: number;
  attempts: SizeAttempt[];
}

export interface SizeSearchOptions {
  minQuality?: number;
  maxQuality?: number;
  /** Encodes after the two bound probes. */
  maxIterations?: number;
  /** Stop once within this fraction below the target. */
  tolerance?: number;
}

export function clampTarget(t: SizeTarget): number {
  return Math.min(t.maxBytes, Math.max(t.minBytes, Math.round(t.targetBytes)));
}

/**
 * `encode(quality)` must return the encoded Blob; size is assumed non-decreasing in quality (true enough for
 * JPEG; every candidate is measured, so a non-monotonic step only costs an iteration).
 */
export async function searchJpegSize(
  encode: (quality: number) => Promise<Blob>,
  t: SizeTarget,
  opts: SizeSearchOptions = {},
): Promise<SizeSearchResult> {
  if (!(t.minBytes > 0) || t.maxBytes < t.minBytes) throw new Error('invalid size bounds');
  const target = clampTarget(t);
  const minQ = opts.minQuality ?? 0.05;
  const maxQ = opts.maxQuality ?? 0.98;
  const maxIterations = opts.maxIterations ?? 10;
  const tol = opts.tolerance ?? 0.015;
  const attempts: SizeAttempt[] = [];
  const within = (size: number) => size >= t.minBytes && size <= t.maxBytes;

  const run = async (q: number) => {
    const quality = Math.round(q * 1000) / 1000;
    const blob = await encode(quality);
    attempts.push({ quality, size: blob.size });
    return { quality, blob, size: blob.size };
  };
  const done = (status: SizeSearchStatus, r: { quality: number; blob: Blob; size: number }): SizeSearchResult => ({
    status,
    blob: r.blob,
    quality: r.quality,
    size: r.size,
    attempts,
  });

  const top = await run(maxQ);
  if (top.size <= target) return done(within(top.size) ? 'fit' : 'too-small', top);
  const bottom = await run(minQ);
  if (bottom.size > target) return done(within(bottom.size) ? 'fit' : 'too-large', bottom);

  let lo = bottom; // size <= target
  let hi = top; // size > target
  for (let i = 0; i < maxIterations && hi.quality - lo.quality > 0.004; i++) {
    const mid = await run((lo.quality + hi.quality) / 2);
    if (mid.size <= target) lo = mid;
    else hi = mid;
    if (lo.size >= target * (1 - tol)) break;
  }
  if (within(lo.size)) return done('fit', lo);
  // The step below the target fell under the tier minimum: the step above is fine if it is still in range.
  if (within(hi.size)) return done('fit', hi);
  return done('no-fit', lo);
}
