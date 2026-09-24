/**
 * Compositor: deterministic post-processing that guarantees the collection rules by construction.
 *
 *   source (any raster sharp decodes)
 *     -> cover-crop to a square
 *     -> gold frame + placard overlay (src/assets, vector, no fonts)
 *     -> JPEG whose byte length lands inside the requested tier's range
 *
 * The byte range is hit with a two-dimensional search: canvas size (a ladder from 1024 to 4096 px)
 * and JPEG quality (binary search per size). If even the largest canvas at quality 100 is under the
 * tier's minimum (flat, low-entropy art), deterministic "canvas grain" is blended in at increasing
 * strengths, which raises entropy without changing the picture. If nothing lands, the result says
 * so (`range_unreachable`) rather than shipping non-compliant bytes.
 *
 * Everything is pure given (bytes, options): same input -> same output bytes, so the sha256 is stable.
 */
import sharp from 'sharp';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { frameGeometry, frameSvg } from './assets/frame.js';
import { MAX_DIMENSION_PX, isPlacard, tierRange, type Placard, type Tier } from './domain/tiers.js';

export interface ComposeOptions {
  tier: Tier;
  /** Placard word. Required when `frame` is true (the default). */
  placard?: Placard;
  /** Draw the frame + placard (default true). `false` only fits to square and hits the byte range. */
  frame?: boolean;
  /** Preferred starting canvas size; the ladder extends both ways from here. Default 1024. */
  baseSize?: number;
}

export interface ComposeResult {
  ok: true;
  bytes: Uint8Array;
  sha256: string;
  contentType: 'image/jpeg';
  contentLength: number;
  width: number;
  height: number;
  tier: Tier;
  placard: Placard | null;
  /** How the range was hit, for the API response and the logs. */
  encoding: { quality: number; canvas: number; grain: number; attempts: number };
}

export interface ComposeFailure {
  ok: false;
  code: 'range_unreachable' | 'undecodable';
  message: string;
  attempts: number;
}

export class ComposeError extends Error {
  constructor(
    readonly code: ComposeFailure['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ComposeError';
  }
}

/** Canvas sizes tried, smallest to largest. All within the mint's dimension bounds. */
export const CANVAS_LADDER: readonly number[] = Object.freeze([512, 768, 1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096]);
/** Grain amplitudes (0..127) blended with `overlay` when the largest canvas is still too small. */
export const GRAIN_LEVELS: readonly number[] = Object.freeze([0, 10, 22, 40, 64]);
const Q_MIN = 5;
const Q_MAX = 100;
/** Decompression-bomb guard for user uploads (8192^2 pixels). */
export const INPUT_PIXEL_LIMIT = 8192 * 8192;

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

interface RawCanvas {
  data: Buffer;
  size: number;
  channels: 3 | 4;
}

async function decodeSquare(src: Uint8Array): Promise<sharp.Sharp> {
  const img = sharp(Buffer.from(src), { limitInputPixels: INPUT_PIXEL_LIMIT, animated: false, failOn: 'error' });
  const meta = await img.metadata();
  if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) throw new ComposeError('undecodable', 'source image is missing or smaller than 64px');
  return img;
}

/** Deterministic grain: xorshift32 noise around mid-grey, amplitude `amp`. */
function grainBuffer(size: number, amp: number, seed = 0x9e3779b9): Buffer {
  const n = size * size;
  const out = Buffer.allocUnsafe(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = 128 + Math.round(((x & 0xff) / 255 - 0.5) * 2 * amp);
  }
  return out;
}

/** Render the framed (or plain) square canvas at `size` as raw pixels, without grain. */
async function renderBase(src: Uint8Array, size: number, placard: Placard | null, frame: boolean): Promise<RawCanvas> {
  const img = await decodeSquare(src);
  let flat: sharp.Sharp;
  if (frame) {
    if (!placard) throw new ComposeError('undecodable', 'placard is required when framing');
    const geom = frameGeometry(size, placard);
    const art = await img
      .clone()
      .rotate() // honour EXIF orientation
      .resize(geom.opening.width, geom.opening.height, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
      .removeAlpha()
      .toBuffer();
    flat = sharp({ create: { width: size, height: size, channels: 3, background: '#2b1d05' } }).composite([
      { input: art, left: geom.opening.x, top: geom.opening.y },
      { input: Buffer.from(frameSvg(geom, placard)), left: 0, top: 0 },
    ]);
  } else {
    flat = img.clone().rotate().resize(size, size, { fit: 'cover', position: 'centre', kernel: 'lanczos3' }).removeAlpha();
  }
  const { data, info } = await flat.raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 && info.channels !== 4) throw new ComposeError('undecodable', `unexpected channel count ${info.channels}`);
  return { data, size, channels: info.channels };
}

/** Blend deterministic grain over a base canvas (overlay keeps mid-tones and the picture intact). */
async function addGrain(base: RawCanvas, grain: number): Promise<RawCanvas> {
  if (grain <= 0) return base;
  const { data, info } = await sharp(base.data, { raw: { width: base.size, height: base.size, channels: base.channels } })
    .composite([{ input: grainBuffer(base.size, grain), raw: { width: base.size, height: base.size, channels: 1 }, blend: 'overlay' }])
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, size: base.size, channels: info.channels as 3 | 4 };
}

/** Per-call cache of ungrained canvases (the 4096 px render dominates cost). Bounded to a few entries. */
class CanvasCache {
  private readonly map = new Map<number, RawCanvas>();
  constructor(
    private readonly render: (size: number) => Promise<RawCanvas>,
    private readonly max = 3,
  ) {}
  async get(size: number, grain: number): Promise<RawCanvas> {
    let base = this.map.get(size);
    if (base) this.map.delete(size);
    else base = await this.render(size);
    this.map.set(size, base);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return addGrain(base, grain);
  }
}

async function encodeJpeg(c: RawCanvas, quality: number): Promise<Buffer> {
  return sharp(c.data, { raw: { width: c.size, height: c.size, channels: c.channels } })
    .removeAlpha()
    .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: false, progressive: false, optimiseCoding: true })
    .toBuffer();
}

interface Hit {
  bytes: Buffer;
  quality: number;
}

/** `gap`: no quality lands in the window at this size; `qAbove` is the lowest quality that overshoots it. */
interface Gap {
  gap: true;
  qAbove: number;
}
type SearchOutcome = Hit | Gap | 'too_small' | 'too_big';
const isHit = (r: SearchOutcome): r is Hit => typeof r === 'object' && 'bytes' in r;
const isGap = (r: SearchOutcome): r is Gap => typeof r === 'object' && 'gap' in r;

/**
 * Highest quality whose output is <= max (binary search), then check it is also >= min. Targeting
 * the top of the range keeps quality as high as the tier allows.
 */
async function searchQuality(c: RawCanvas, min: number, max: number, count: { n: number }): Promise<SearchOutcome> {
  const enc = async (q: number) => {
    count.n++;
    return encodeJpeg(c, q);
  };
  const hi = await enc(Q_MAX);
  if (hi.length < min) return 'too_small';
  if (hi.length <= max) return { bytes: hi, quality: Q_MAX };
  const lo = await enc(Q_MIN);
  if (lo.length > max) return 'too_big';
  let a = Q_MIN; // known <= max
  let aBytes = lo;
  let b = Q_MAX; // known > max
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    const out = await enc(mid);
    if (out.length <= max) {
      a = mid;
      aBytes = out;
    } else b = mid;
  }
  if (aBytes.length >= min) return { bytes: aBytes, quality: a };
  // JPEG size is not perfectly monotonic in quality; scan the neighbours before giving up.
  for (const q of [a - 1, a + 2]) {
    if (q < Q_MIN || q > Q_MAX) continue;
    const out = await enc(q);
    if (out.length >= min && out.length <= max) return { bytes: out, quality: q };
  }
  return { gap: true, qAbove: b };
}

/** Below this JPEG quality the compositor tries a smaller canvas (same bytes, fewer pixels, cleaner pixels). */
export const PREFERRED_MIN_QUALITY = 60;
/** Never trade quality for a canvas smaller than this. */
const MIN_PREFERRED_CANVAS = 768;
/** Canvas-size bisection stops when the interval is narrower than this many px. */
const SIZE_RESOLUTION = 8;

/**
 * Compose and encode. Never throws for range problems: returns a `ComposeFailure` so the API can
 * explain it. Throws `ComposeError('undecodable')` for input sharp cannot read.
 */
export async function compose(src: Uint8Array, opts: ComposeOptions): Promise<ComposeResult | ComposeFailure> {
  const frame = opts.frame ?? true;
  const placard = opts.placard ?? null;
  if (frame && !isPlacard(placard)) throw new ComposeError('undecodable', 'placard must be one of DEGEN, DEGENT, REGEN');
  const range = tierRange(opts.tier);
  const ladder = CANVAS_LADDER.filter((s) => s <= MAX_DIMENSION_PX);
  const last = ladder.length - 1;
  const found = ladder.findIndex((s) => s >= (opts.baseSize ?? 1024));
  const start = found === -1 ? last : found;
  const count = { n: 0 };
  const canvases = new CanvasCache((size) => renderBase(src, size, placard, frame));

  const done = (hit: Hit, size: number, grain: number): ComposeResult => {
    const bytes = new Uint8Array(hit.bytes.buffer, hit.bytes.byteOffset, hit.bytes.byteLength);
    return {
      ok: true,
      bytes,
      sha256: sha256Hex(bytes),
      contentType: 'image/jpeg',
      contentLength: bytes.length,
      width: size,
      height: size,
      tier: opts.tier,
      placard: frame ? placard : null,
      encoding: { quality: hit.quality, canvas: size, grain, attempts: count.n },
    };
  };

  for (const grain of GRAIN_LEVELS) {
    const memo = new Map<number, SearchOutcome>();
    const at = async (i: number): Promise<SearchOutcome> => {
      let r = memo.get(i);
      if (r === undefined) {
        r = await searchQuality(await canvases.get(ladder[i]!, grain), range.minBytes, range.maxBytes, count);
        memo.set(i, r);
      }
      return r;
    };
    // Fixed-quality encode at an arbitrary canvas size (for the size bisection).
    const encodeAt = async (size: number, q: number): Promise<Buffer> => {
      count.n++;
      return encodeJpeg(await canvases.get(size, grain), q);
    };

    // 1. Too small at the start size: probe the largest canvas first (if even that is too small,
    //    only grain can help), else bisect the ladder for the smallest size that is not too small.
    //    The probe is one q=100 encode per size; the full quality search runs only where it matters.
    const reachesMin = async (k: number): Promise<boolean> => {
      const m = memo.get(k);
      if (m !== undefined) return m !== 'too_small';
      return (await encodeAt(ladder[k]!, Q_MAX)).length >= range.minBytes;
    };
    let i = start;
    let r = await at(i);
    if (r === 'too_small') {
      if (i === last || !(await reachesMin(last))) continue;
      let lo = i;
      let hi = last;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (await reachesMin(m)) hi = m;
        else lo = m;
      }
      i = hi;
      r = await at(i);
    }
    // 2. Walk down while it is too big.
    while (r === 'too_big' && i > 0) r = await at(--i);

    // 3. The quality steps straddle the window at this size (typical near q=100, where one step is
    //    bigger than the Full Block window). Hold quality at the step just above the window and
    //    bisect the canvas edge instead: bytes grow smoothly with pixel count.
    if (isGap(r)) {
      const q = r.qAbove;
      let lo = i > 0 ? ladder[i - 1]! : Math.max(256, Math.floor(ladder[i]! / 2)); // assumed <= max at q
      let hi = ladder[i]!; // > max at q
      let hitSize: { hit: Hit; size: number } | null = null;
      while (hi - lo > SIZE_RESOLUTION && !hitSize) {
        const mid = Math.round((lo + hi) / 2 / 4) * 4;
        if (mid <= lo || mid >= hi) break;
        const out = await encodeAt(mid, q);
        if (out.length > range.maxBytes) hi = mid;
        else if (out.length < range.minBytes) lo = mid;
        else hitSize = { hit: { bytes: out, quality: q }, size: mid };
      }
      if (hitSize) return done(hitSize.hit, hitSize.size, grain);
      continue; // grain changes the size curve; try the next level
    }
    if (!isHit(r)) {
      // Only "too small at the largest canvas" can be helped by grain; "too big" at the smallest cannot.
      if (r === 'too_big') break;
      continue;
    }
    // 4. Prefer a smaller canvas over a heavily quantised large one.
    let hit: Hit = r;
    while (hit.quality < PREFERRED_MIN_QUALITY && i > 0 && ladder[i - 1]! >= MIN_PREFERRED_CANVAS) {
      const down = await at(i - 1);
      if (!isHit(down) || down.quality <= hit.quality) break;
      hit = down;
      i--;
    }
    return done(hit, ladder[i]!, grain);
  }
  return {
    ok: false,
    code: 'range_unreachable',
    message: `could not encode a JPEG between ${range.minBytes} and ${range.maxBytes} bytes for the ${range.label} tier from this source (tried canvas sizes ${ladder[0]}-${ladder[last]}px, quality ${Q_MIN}-${Q_MAX}, grain up to ${GRAIN_LEVELS[GRAIN_LEVELS.length - 1]})`,
    attempts: count.n,
  };
}

/** A small JPEG preview (no frame) for job listings; not the mint bytes. */
export async function preview(src: Uint8Array, size = 512): Promise<Uint8Array> {
  const img = await decodeSquare(src);
  const out = await img.rotate().resize(size, size, { fit: 'cover', position: 'centre' }).removeAlpha().jpeg({ quality: 82 }).toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Decoded dimensions via sharp (used for candidate metadata; the review uses the header parser). */
export async function dimensions(src: Uint8Array): Promise<{ width: number; height: number }> {
  const meta = await sharp(Buffer.from(src), { limitInputPixels: INPUT_PIXEL_LIMIT }).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}
