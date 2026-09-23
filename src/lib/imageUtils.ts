/**
 * Canvas compositing and size targeting for Degent mint artwork.
 *
 * Output is a 1024x1024 JPEG. Ordinals inscriptions pay per byte, so the
 * page aims for a 200-400 KB file and this module searches JPEG quality to
 * land on a chosen target size.
 */

export const CANVAS_SIZE = 1024
export const TARGET_MIN_KB = 200
export const TARGET_MAX_KB = 400
export const DEFAULT_BORDER_PERCENT = 15
export const MIN_BORDER_PERCENT = 5
export const MAX_BORDER_PERCENT = 25

export interface CombineOptions {
  /** JPEG quality 0..1. */
  quality?: number
  /** Frame border thickness as a percentage of the canvas edge (5..25). */
  borderPercent?: number
}

export interface CombineResult {
  dataUrl: string
  blob: Blob
  sizeBytes: number
  sizeKB: number
  quality: number
}

/** Clamp the border to the supported range. */
export function clampBorderPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BORDER_PERCENT
  return Math.min(MAX_BORDER_PERCENT, Math.max(MIN_BORDER_PERCENT, value))
}

/** Geometry of the inner picture area for a given border percentage. */
export function innerRect(borderPercent: number, size: number = CANVAS_SIZE) {
  const pct = clampBorderPercent(borderPercent) / 100
  const offset = Math.round(size * pct)
  const inner = size - 2 * offset
  return { x: offset, y: offset, width: inner, height: inner }
}

function loadImage(src: string, label: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load ${label}`))
    img.src = src
  })
}

/** Promise wrapper over canvas.toBlob. */
export function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/jpeg',
      quality,
    )
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Draw the frame, then the user's image inside the border, onto a fresh
 * canvas. Returns the canvas so callers can re-encode at different qualities
 * without redrawing.
 */
export async function composeCanvas(
  userImageUrl: string,
  frameImageUrl: string,
  borderPercent: number = DEFAULT_BORDER_PERCENT,
): Promise<HTMLCanvasElement> {
  const [userImg, frameImg] = await Promise.all([
    loadImage(userImageUrl, 'user image'),
    loadImage(frameImageUrl, 'frame image'),
  ])

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_SIZE
  canvas.height = CANVAS_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get canvas context')

  ctx.drawImage(frameImg, 0, 0, CANVAS_SIZE, CANVAS_SIZE)
  const r = innerRect(borderPercent)
  ctx.drawImage(userImg, r.x, r.y, r.width, r.height)
  return canvas
}

/** Encode a composed canvas at a fixed quality. */
export async function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<CombineResult> {
  const blob = await canvasToBlob(canvas, quality)
  const dataUrl = await blobToDataUrl(blob)
  return {
    dataUrl,
    blob,
    sizeBytes: blob.size,
    sizeKB: Math.round(blob.size / 1024),
    quality,
  }
}

/** One-shot: compose and encode at a fixed quality. */
export async function combineImages(
  userImageUrl: string,
  frameImageUrl: string,
  options: CombineOptions = {},
): Promise<CombineResult> {
  const canvas = await composeCanvas(userImageUrl, frameImageUrl, options.borderPercent)
  return encodeCanvas(canvas, options.quality ?? 0.92)
}

// ---------------------------------------------------------------------------
// Size targeting
// ---------------------------------------------------------------------------

export interface SizeSearchOptions {
  /** Lower bound of the acceptable byte range. */
  minBytes?: number
  /** Upper bound of the acceptable byte range. */
  maxBytes?: number
  /** Quality search bounds. */
  minQuality?: number
  maxQuality?: number
  /** Max encode attempts. */
  maxIterations?: number
}

export interface SizeSearchResult<T> {
  quality: number
  sizeBytes: number
  value: T
  /** Whether sizeBytes ended inside [minBytes, maxBytes]. */
  inRange: boolean
  iterations: number
}

/**
 * Binary-search JPEG quality so the encoded size lands as close as possible
 * to `targetBytes`, preferring results inside [minBytes, maxBytes].
 *
 * `encode(quality)` must return something with a byte size (a Blob, or any
 * `{ size }`), and size must be monotonic non-decreasing in quality.
 */
export async function findQualityForTargetSize<T extends { size: number }>(
  encode: (quality: number) => Promise<T>,
  targetBytes: number,
  opts: SizeSearchOptions = {},
): Promise<SizeSearchResult<T>> {
  const minBytes = opts.minBytes ?? TARGET_MIN_KB * 1024
  const maxBytes = opts.maxBytes ?? TARGET_MAX_KB * 1024
  let lo = opts.minQuality ?? 0.3
  let hi = opts.maxQuality ?? 0.98
  const maxIterations = opts.maxIterations ?? 8

  let best: { quality: number; value: T } | null = null
  let iterations = 0

  const consider = (quality: number, value: T) => {
    if (!best) {
      best = { quality, value }
      return
    }
    const bestIn = best.value.size >= minBytes && best.value.size <= maxBytes
    const thisIn = value.size >= minBytes && value.size <= maxBytes
    if (thisIn && !bestIn) {
      best = { quality, value }
      return
    }
    if (bestIn && !thisIn) return
    if (Math.abs(value.size - targetBytes) < Math.abs(best.value.size - targetBytes)) {
      best = { quality, value }
    }
  }

  // Probe the bounds first so we know if the target is reachable at all.
  const atHi = await encode(hi)
  iterations++
  consider(hi, atHi)
  if (atHi.size <= targetBytes) {
    return finish(best!, minBytes, maxBytes, iterations)
  }

  const atLo = await encode(lo)
  iterations++
  consider(lo, atLo)
  if (atLo.size >= targetBytes) {
    return finish(best!, minBytes, maxBytes, iterations)
  }

  while (iterations < maxIterations && hi - lo > 0.005) {
    const mid = (lo + hi) / 2
    const value = await encode(mid)
    iterations++
    consider(mid, value)
    if (value.size > targetBytes) hi = mid
    else lo = mid
    // Early exit when we're within 2% of target.
    if (Math.abs(value.size - targetBytes) <= targetBytes * 0.02) break
  }

  return finish(best!, minBytes, maxBytes, iterations)
}

function finish<T extends { size: number }>(
  best: { quality: number; value: T },
  minBytes: number,
  maxBytes: number,
  iterations: number,
): SizeSearchResult<T> {
  return {
    quality: best.quality,
    sizeBytes: best.value.size,
    value: best.value,
    inRange: best.value.size >= minBytes && best.value.size <= maxBytes,
    iterations,
  }
}

/**
 * Compose once, then search quality to hit `targetKB`.
 */
export async function combineImagesToTargetSize(
  userImageUrl: string,
  frameImageUrl: string,
  targetKB: number,
  options: Omit<CombineOptions, 'quality'> = {},
): Promise<CombineResult & { inRange: boolean }> {
  const canvas = await composeCanvas(userImageUrl, frameImageUrl, options.borderPercent)
  const result = await findQualityForTargetSize((q) => canvasToBlob(canvas, q), targetKB * 1024)
  const dataUrl = await blobToDataUrl(result.value)
  return {
    dataUrl,
    blob: result.value,
    sizeBytes: result.sizeBytes,
    sizeKB: Math.round(result.sizeBytes / 1024),
    quality: result.quality,
    inRange: result.inRange,
  }
}

// ---------------------------------------------------------------------------
// Inscription cost estimate
// ---------------------------------------------------------------------------

/**
 * Fixed overhead of a commit + reveal pair, in vbytes, excluding the content
 * itself. Roughly: a 1-in/1-out P2TR commit (~110 vB) plus the reveal's
 * non-content parts (input, output, control block, envelope opcodes, ~90 vB).
 */
export const INSCRIPTION_OVERHEAD_VBYTES = 200

export interface InscriptionEstimate {
  contentBytes: number
  /** Content lives in the witness: 1 weight unit per byte = 0.25 vB per byte. */
  contentVBytes: number
  totalVBytes: number
  /** Total fee in sats at `feeRate` sat/vB. */
  feeSats: number
  feeRate: number
}

export function estimateInscription(contentBytes: number, feeRate: number = 1): InscriptionEstimate {
  const bytes = Math.max(0, Math.floor(contentBytes))
  const contentVBytes = Math.ceil(bytes / 4)
  const totalVBytes = contentVBytes + INSCRIPTION_OVERHEAD_VBYTES
  return {
    contentBytes: bytes,
    contentVBytes,
    totalVBytes,
    feeSats: Math.ceil(totalVBytes * feeRate),
    feeRate,
  }
}

export function downloadImage(dataUrl: string, filename: string = 'degent-frame.jpg') {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
