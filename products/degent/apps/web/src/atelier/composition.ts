/**
 * Atelier geometry (pure): square crop of the source, gold frame of adjustable width (5–25 % of the side, the
 * legacy combiner's range) and the placard on the bottom rail. The canvas drawing (`draw.ts`) only paints what
 * this computes, so dimensions are unit-tested without a canvas.
 */

/** Mint rule 3: the placard must say one of these, exactly. */
export const PLACARD_TEXTS = ['DEGEN', 'DEGENT', 'REGEN'] as const;
export type PlacardText = (typeof PLACARD_TEXTS)[number];

export function isPlacardText(s: unknown): s is PlacardText {
  return typeof s === 'string' && (PLACARD_TEXTS as readonly string[]).includes(s);
}

export const FRAME_MIN_PCT = 5;
export const FRAME_MAX_PCT = 25;
export const FRAME_DEFAULT_PCT = 12;

export function clampFramePct(v: number): number {
  if (!Number.isFinite(v)) return FRAME_DEFAULT_PCT;
  return Math.min(FRAME_MAX_PCT, Math.max(FRAME_MIN_PCT, v));
}

/** Output edge lengths offered (square). All sit inside the collection's 500–4096 px bounds. */
export const OUTPUT_SIZES = [1024, 1200, 1500, 2000] as const;
export const DEFAULT_OUTPUT_SIZE = 1200;

export interface CropState {
  /** 1 = the largest centred square; up to 4x. */
  zoom: number;
  /** -1 (left/top) … 1 (right/bottom): where the square sits inside the free space. */
  panX: number;
  panY: number;
}

export const DEFAULT_CROP: CropState = { zoom: 1, panX: 0, panY: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));

/** The square region of the source to draw (source pixels). Mint rule 1: the output is square. */
export function squareCrop(srcW: number, srcH: number, crop: CropState = DEFAULT_CROP): { sx: number; sy: number; side: number } {
  if (!(srcW > 0 && srcH > 0)) throw new Error('source has no pixels');
  const side = Math.min(srcW, srcH) / clamp(crop.zoom, 1, 4);
  const freeX = srcW - side;
  const freeY = srcH - side;
  const sx = freeX / 2 + (clamp(crop.panX, -1, 1) * freeX) / 2;
  const sy = freeY / 2 + (clamp(crop.panY, -1, 1) * freeY) / 2;
  return { sx: Math.round(sx), sy: Math.round(sy), side: Math.round(side) };
}

export interface CompositionSpec {
  /** Output edge in px (square). */
  size: number;
  /** Frame width as % of the edge, clamped to 5–25. */
  framePct: number;
  placard: PlacardText;
  crop: CropState;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompositionLayout {
  size: number;
  /** Source crop (square). */
  crop: { sx: number; sy: number; sw: number; sh: number };
  /** Frame rail thickness in px. */
  frame: number;
  /** Where the art is drawn: inside the frame. */
  art: Rect;
  /** The placard plate, centred on the bottom rail. */
  placard: Rect;
  placardFontPx: number;
  text: PlacardText;
}

export function layoutComposition(srcW: number, srcH: number, spec: CompositionSpec): CompositionLayout {
  if (!isPlacardText(spec.placard)) throw new Error(`placard must say one of ${PLACARD_TEXTS.join(', ')}`);
  const size = Math.round(spec.size);
  if (!(size >= 64)) throw new Error('output too small');
  const frame = Math.round((size * clampFramePct(spec.framePct)) / 100);
  const c = squareCrop(srcW, srcH, spec.crop);
  const art: Rect = { x: frame, y: frame, w: size - 2 * frame, h: size - 2 * frame };
  // The plate: ~30 % of the edge wide, 7 % high, centred on the bottom rail (it may overlap the art on thin frames,
  // like a plaque screwed onto the moulding), never past the outer edge.
  const h = Math.round(size * 0.07);
  const w = Math.round(size * 0.3);
  const centreY = size - frame / 2;
  const y = Math.round(Math.min(centreY - h / 2, size - h - Math.round(size * 0.012)));
  const placard: Rect = { x: Math.round((size - w) / 2), y, w, h };
  return {
    size,
    crop: { sx: c.sx, sy: c.sy, sw: c.side, sh: c.side },
    frame,
    art,
    placard,
    placardFontPx: Math.round(h * 0.56),
    text: spec.placard,
  };
}
