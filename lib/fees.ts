/**
 * Fee-rate policy and cost estimation.
 *
 * All rates are sats/vB. The bounds are product decisions:
 *  - FEE_MIN 0.13: the lowest rate the Skrybit backend accepts.
 *  - FEE_MAX 500: a sanity ceiling; nobody needs more to inscribe an image.
 *  - FEE_WARN 50: above this we ask the user to confirm in-page before paying.
 */

export const FEE_MIN = 0.13;
export const FEE_MAX = 500;
export const FEE_WARN = 50;
export const FEE_DEFAULT = 1;

/** Approximate non-witness overhead of a reveal transaction, in vbytes. */
export const REVEAL_OVERHEAD_VBYTES = 200;
/** Approximate size of the commit transaction paid by the user, in vbytes. */
export const COMMIT_VBYTES = 154;
/** Postage: the sats that end up locked in the inscription output. */
export const POSTAGE_SATS = 546;

export const SATS_PER_BTC = 100_000_000;

export interface FeePresets {
  economy: number;
  normal: number;
  fast: number;
  /** false when values are the static fallback rather than live mempool data. */
  live: boolean;
}

export const FALLBACK_PRESETS: FeePresets = { economy: 1, normal: 2, fast: 5, live: false };

const MEMPOOL_FEES_URL = 'https://mempool.space/api/v1/fees/recommended';
const MEMPOOL_PRICES_URL = 'https://mempool.space/api/v1/prices';

/** Round to two decimals; avoids 0.1 + 0.2 style noise in the input field. */
export function roundFeeRate(rate: number): number {
  return Math.round(rate * 100) / 100;
}

/**
 * Clamp a user-entered rate into [FEE_MIN, FEE_MAX]. NaN returns FEE_MIN so
 * the UI never ends up with an unusable value.
 */
export function clampFeeRate(rate: number): number {
  if (Number.isNaN(rate)) return FEE_MIN;
  return roundFeeRate(Math.min(FEE_MAX, Math.max(FEE_MIN, rate)));
}

export function isFeeRateInRange(rate: number): boolean {
  return Number.isFinite(rate) && rate >= FEE_MIN && rate <= FEE_MAX;
}

/**
 * Estimate the virtual size of an inscription reveal for a payload of `bytes`.
 * Witness data is discounted 4x, plus a fixed overhead for the envelope and
 * the non-witness parts of the transaction.
 */
export function estimateInscriptionVbytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return REVEAL_OVERHEAD_VBYTES;
  return Math.ceil(bytes / 4) + REVEAL_OVERHEAD_VBYTES;
}

/**
 * Rough end-to-end cost estimate (commit + reveal + postage) in sats. This is
 * a preview only; the authoritative amount always comes from the quote.
 */
export function estimateFeeSats(bytes: number, feeRate: number): number {
  const rate = clampFeeRate(feeRate);
  const vbytes = estimateInscriptionVbytes(bytes) + COMMIT_VBYTES;
  return Math.ceil(vbytes * rate) + POSTAGE_SATS;
}

export function satsToBtc(sats: number): number {
  return sats / SATS_PER_BTC;
}

export function formatBtc(sats: number): string {
  return satsToBtc(sats).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0');
}

export function formatUsd(sats: number, usdPerBtc: number): string {
  const usd = satsToBtc(sats) * usdPerBtc;
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

type FetchLike = typeof fetch;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Fetch recommended fee presets from mempool.space. Any failure (network,
 * HTTP error, malformed body) resolves to FALLBACK_PRESETS with live=false.
 */
export async function fetchMempoolPresets(fetchImpl: FetchLike = fetch): Promise<FeePresets> {
  try {
    const res = await fetchImpl(MEMPOOL_FEES_URL, { cache: 'no-store' });
    if (!res.ok) return FALLBACK_PRESETS;
    const body = (await res.json()) as Record<string, unknown>;
    const economy = body.economyFee;
    const normal = body.halfHourFee;
    const fast = body.fastestFee;
    if (!isPositiveNumber(economy) || !isPositiveNumber(normal) || !isPositiveNumber(fast)) {
      return FALLBACK_PRESETS;
    }
    return {
      economy: clampFeeRate(economy),
      normal: clampFeeRate(normal),
      fast: clampFeeRate(fast),
      live: true,
    };
  } catch {
    return FALLBACK_PRESETS;
  }
}

/** USD price of one BTC from mempool.space, or null when unavailable. */
export async function fetchBtcUsdPrice(fetchImpl: FetchLike = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(MEMPOOL_PRICES_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    return isPositiveNumber(body.USD) ? body.USD : null;
  } catch {
    return null;
  }
}
