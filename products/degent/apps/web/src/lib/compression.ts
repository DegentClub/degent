/**
 * Byte-range targeting for the client-side compression toolkit.
 *
 * Pure: the actual encoder (canvas → WebP/JPEG) is injected, so the search logic is unit-tested
 * with a mocked encoder. Assumes encoded size is monotonic non-decreasing in quality and scale,
 * which holds well enough for WebP/JPEG to converge; every candidate is re-measured, never guessed.
 */

export interface ByteRange {
  min: number;
  max: number;
}

export type SizeFit = 'below' | 'within' | 'above';

export function classifySize(size: number, range: ByteRange): SizeFit {
  if (size < range.min) return 'below';
  if (size > range.max) return 'above';
  return 'within';
}

export interface Attempt {
  quality: number;
  scale: number;
  size: number;
}

export type Encoder = (quality: number, scale: number) => Promise<{ size: number }>;

export interface FitOptions {
  minQuality?: number;
  maxQuality?: number;
  /** Downscale ladder tried in order when even minQuality is too big. First entry is the start. */
  scales?: number[];
  /** Bisection steps per scale. */
  iterations?: number;
  /** Stop downscaling at this many px on the short edge (enforced by caller via `scales`). */
}

export type FitResult =
  | { status: 'fit'; best: Attempt; attempts: Attempt[] }
  | { status: 'too-small'; best: Attempt; attempts: Attempt[] }
  | { status: 'too-large'; best: Attempt; attempts: Attempt[] }
  | { status: 'no-fit'; best: Attempt; attempts: Attempt[] };

export const DEFAULT_SCALES = [1, 0.85, 0.7, 0.6, 0.5, 0.4, 0.3];

/**
 * Find the highest-quality encoding whose byte size lands inside `range`, downscaling only when
 * the minimum quality at the current scale is still too large.
 */
export async function fitToRange(encode: Encoder, range: ByteRange, opts: FitOptions = {}): Promise<FitResult> {
  const minQ = opts.minQuality ?? 0.05;
  const maxQ = opts.maxQuality ?? 0.95;
  const scales = opts.scales ?? DEFAULT_SCALES;
  const iterations = opts.iterations ?? 7;
  const attempts: Attempt[] = [];

  const run = async (quality: number, scale: number): Promise<Attempt> => {
    const q = Math.round(quality * 1000) / 1000;
    const { size } = await encode(q, scale);
    const a = { quality: q, scale, size };
    attempts.push(a);
    return a;
  };

  let smallest: Attempt | null = null;
  for (const [i, scale] of scales.entries()) {
    const top = await run(maxQ, scale);
    const topFit = classifySize(top.size, range);
    if (topFit === 'within') return { status: 'fit', best: top, attempts };
    if (topFit === 'below') {
      // Smaller scales only get smaller. At the first scale this means the source can't reach min.
      return i === 0
        ? { status: 'too-small', best: top, attempts }
        : { status: 'no-fit', best: smallest ?? top, attempts };
    }
    const bottom = await run(minQ, scale);
    smallest = bottom;
    const bottomFit = classifySize(bottom.size, range);
    if (bottomFit === 'above') continue; // downscale
    if (bottomFit === 'within' && iterations === 0) return { status: 'fit', best: bottom, attempts };

    // Bisect for the largest quality with size <= max.
    let lo = bottom; // size <= max
    let hi = top; // size > max
    for (let k = 0; k < iterations; k++) {
      const mid = await run((lo.quality + hi.quality) / 2, scale);
      if (mid.size > range.max) hi = mid;
      else lo = mid;
      if (hi.quality - lo.quality < 0.005) break;
    }
    if (classifySize(lo.size, range) === 'within') return { status: 'fit', best: lo, attempts };
    return { status: 'no-fit', best: lo, attempts };
  }
  return { status: 'too-large', best: smallest ?? attempts[attempts.length - 1]!, attempts };
}

/** Scale ladder that never drops the short edge below `minDimensionPx`. */
export function scaleLadder(width: number, height: number, minDimensionPx: number, ladder = DEFAULT_SCALES): number[] {
  const short = Math.min(width, height);
  const allowed = ladder.filter((s) => Math.round(short * s) >= minDimensionPx);
  return allowed.length > 0 ? allowed : [1];
}

/** Scale needed so the long edge fits `maxDimensionPx` (1 if it already fits). */
export function capScale(width: number, height: number, maxDimensionPx: number): number {
  const long = Math.max(width, height);
  return long > maxDimensionPx ? maxDimensionPx / long : 1;
}
