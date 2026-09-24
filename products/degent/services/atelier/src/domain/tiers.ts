/**
 * Tier byte ranges and placard words: the two rules the Atelier must satisfy BY CONSTRUCTION.
 *
 * The numbers mirror `@bsh/degent-mint-sdk` (ADR-0005 §3) but are re-declared here on purpose:
 * components share code only via platform/ and contracts/, and the mint's contract
 * (contracts/openapi/degent-mint.yaml) is the source of truth both copy. `test/tiers.test.ts`
 * reads the mint contract and asserts these numbers agree with it.
 */
export type Tier = 'standard' | 'large' | 'fullblock';
export type Placard = 'DEGEN' | 'DEGENT' | 'REGEN';

export interface TierRange {
  tier: Tier;
  label: string;
  minBytes: number;
  maxBytes: number;
}

export const TIERS: readonly TierRange[] = Object.freeze([
  { tier: 'standard', label: 'Standard Degent', minBytes: 200_000, maxBytes: 400_000 },
  { tier: 'large', label: 'Large Degent', minBytes: 400_001, maxBytes: 3_499_999 },
  { tier: 'fullblock', label: 'Full Block Degent', minBytes: 3_500_000, maxBytes: 3_900_000 },
]);

export const PLACARDS: readonly Placard[] = Object.freeze(['DEGEN', 'DEGENT', 'REGEN']);

/** Dimension bounds the mint enforces (`DEFAULT_CONFIG.minDimensionPx/maxDimensionPx`). */
export const MIN_DIMENSION_PX = 256;
export const MAX_DIMENSION_PX = 4096;
/** Largest request body accepted by POST /v1/upload. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_VARIATIONS = 4;
/** Accepted image types for user uploads (what the mint accepts, minus animated GIF which cannot be framed). */
export const ACCEPTED_UPLOAD_TYPES: readonly string[] = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

export function isTier(v: unknown): v is Tier {
  return v === 'standard' || v === 'large' || v === 'fullblock';
}

export function isPlacard(v: unknown): v is Placard {
  return typeof v === 'string' && (PLACARDS as readonly string[]).includes(v);
}

export function tierRange(tier: Tier): TierRange {
  const r = TIERS.find((t) => t.tier === tier);
  if (!r) throw new RangeError(`unknown tier ${tier}`);
  return r;
}

/** The tier whose byte range contains `bytes`, or null. */
export function tierForSize(bytes: number): TierRange | null {
  if (!Number.isInteger(bytes) || bytes < 0) return null;
  return TIERS.find((t) => bytes >= t.minBytes && bytes <= t.maxBytes) ?? null;
}
