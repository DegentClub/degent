/**
 * degent.club mint rules shared by the browser and the service (ADR-0002 §5, ADR-0005 §3-§4).
 * Pure functions only: no I/O, no network, safe to run in either environment.
 *
 * Two independent axes (ADR-0005 §3):
 *   - TIER is a product decision on CONTENT BYTES, chosen by the owner: Standard / Large / Full Block.
 *   - LANE is transport, decided by the reveal WEIGHT: <= 400,000 WU relays through the normal
 *     mempool ("standard"), anything heavier needs the non-standard block lane. So a Standard
 *     Degent of ~397-400 KB travels the block lane and the quote says so.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CollectionConfig, Lane, Quote, ReviewCheck, Tier, TierRule } from './types.js';

export const STANDARD_MIN_BYTES = 200_000;
export const STANDARD_MAX_BYTES = 400_000;
export const LARGE_MIN_BYTES = 400_001;
export const LARGE_MAX_BYTES = 3_499_999;
export const FULLBLOCK_MIN_BYTES = 3_500_000;
export const FULLBLOCK_MAX_BYTES = 3_900_000;
/** Largest request body the service accepts for PUT /content (4 MiB). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Block-lane ETA is block slot x ~10 minutes, never a promise. */
export const BLOCK_INTERVAL_MINUTES = 10;
/**
 * Lane thresholds. Same numbers as `@bsh/inscription.LIMITS` (MAX_STANDARD_TX_WEIGHT and
 * BLOCK_LANE_MAX_TX_WEIGHT); the service asserts the two agree. Kept here because the SDK must not
 * depend on the transaction library, yet the browser and the service must agree on lane names.
 */
export const STANDARD_LANE_MAX_WEIGHT = 400_000;
/** Per-block weight budget of the block lane (ADR-0005 §4): 4,000,000 WU minus header + coinbase headroom. */
export const BLOCK_LANE_WEIGHT_BUDGET = 3_990_000;

/** Transport lane for a reveal of `weight` WU; null when it fits no lane. */
export function laneForWeight(weight: number): Lane | null {
  if (!Number.isFinite(weight) || weight <= 0) return null;
  if (weight <= STANDARD_LANE_MAX_WEIGHT) return 'standard';
  if (weight <= BLOCK_LANE_WEIGHT_BUDGET) return 'block';
  return null;
}

export const TIER_LABELS: Record<Tier, string> = Object.freeze({
  standard: 'Standard Degent',
  large: 'Large Degent',
  fullblock: 'Full Block Degent',
});

export const DEFAULT_CONFIG: CollectionConfig = Object.freeze({
  network: 'mainnet',
  collectionName: 'Decentralized Gentlemen Club',
  parentInscriptionId: null,
  allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'],
  tiers: [
    {
      tier: 'standard',
      minBytes: STANDARD_MIN_BYTES,
      maxBytes: STANDARD_MAX_BYTES,
      lane: 'standard',
      sharesBlock: true,
      label: TIER_LABELS.standard,
      description:
        '200-400 KB. Usually a standard reveal (<= 400,000 WU) through the normal mempool, many per block. ' +
        'The last few KB of the range weigh more than 400,000 WU and travel the block lane instead.',
    },
    {
      tier: 'large',
      minBytes: LARGE_MIN_BYTES,
      maxBytes: LARGE_MAX_BYTES,
      lane: 'block',
      sharesBlock: true,
      label: TIER_LABELS.large,
      description:
        '400 KB-3.5 MB. Non-standard reveal via Libre Relay / Slipstream. Shares a block with other Large Degents ' +
        'when their weights fit the 3,990,000 WU budget.',
    },
    {
      tier: 'fullblock',
      minBytes: FULLBLOCK_MIN_BYTES,
      maxBytes: FULLBLOCK_MAX_BYTES,
      lane: 'block',
      sharesBlock: false,
      label: TIER_LABELS.fullblock,
      description: '3.5-3.9 MB. Fills a Bitcoin block on its own: always revealed alone, one per block slot.',
    },
  ] satisfies TierRule[],
  maxDimensionPx: 4096,
  minDimensionPx: 256,
  postageSats: 546,
  serviceFeeSats: { standard: 0, large: 0, fullblock: 0 },
  minFeeRate: 1,
  quoteTtlSeconds: 900,
  rescueAfterSeconds: 6 * 60 * 60,
}) as CollectionConfig;

/** The tier whose byte range contains `bytes`, or null when outside every tier. */
export function tierForSize(bytes: number, config: CollectionConfig = DEFAULT_CONFIG): TierRule | null {
  if (!Number.isInteger(bytes) || bytes < 0) return null;
  return config.tiers.find((t) => bytes >= t.minBytes && bytes <= t.maxBytes) ?? null;
}

export function tierRule(tier: Tier, config: CollectionConfig = DEFAULT_CONFIG): TierRule | null {
  return config.tiers.find((t) => t.tier === tier) ?? null;
}

export interface ContentMeta {
  contentType: string;
  contentLength: number;
  width?: number;
  height?: number;
  /** When given, the declared tier must match the tier implied by the size. */
  tier?: Tier;
}

export interface MetaValidation {
  ok: boolean;
  tier: TierRule | null;
  checks: ReviewCheck[];
  /** Human-readable reasons for every failed check (empty when ok). */
  reasons: string[];
}

/**
 * Validate declared content metadata against the collection rules. Every rule yields a check,
 * passed or not, so a UI can show the full list. Dimensions are only checked when provided.
 */
export function validateContentMeta(meta: ContentMeta, config: CollectionConfig = DEFAULT_CONFIG): MetaValidation {
  const checks: ReviewCheck[] = [];
  const type = (meta.contentType ?? '').toLowerCase().trim();
  checks.push({
    id: 'content_type',
    passed: config.allowedContentTypes.includes(type),
    detail: config.allowedContentTypes.includes(type)
      ? `${type} is allowed`
      : `${meta.contentType || '(none)'} is not allowed; use one of ${config.allowedContentTypes.join(', ')}`,
  });

  const tier = tierForSize(meta.contentLength, config);
  const min = Math.min(...config.tiers.map((t) => t.minBytes));
  const max = Math.max(...config.tiers.map((t) => t.maxBytes));
  checks.push({
    id: 'size',
    passed: tier !== null,
    detail: tier
      ? `${meta.contentLength} bytes fits the ${tier.label} tier (${tier.minBytes}-${tier.maxBytes})`
      : `${meta.contentLength} bytes is outside ${min}-${max} bytes`,
  });

  if (meta.tier !== undefined) {
    const matches = tier !== null && tier.tier === meta.tier;
    checks.push({
      id: 'tier',
      passed: matches,
      detail: matches
        ? `declared tier ${meta.tier} matches the size`
        : `declared tier ${meta.tier} does not match the size (expected ${tier?.tier ?? 'none'})`,
    });
  }

  for (const [id, value] of [
    ['width', meta.width],
    ['height', meta.height],
  ] as const) {
    if (value === undefined) continue;
    const ok = Number.isInteger(value) && value >= config.minDimensionPx && value <= config.maxDimensionPx;
    checks.push({
      id,
      passed: ok,
      detail: ok
        ? `${id} ${value}px within ${config.minDimensionPx}-${config.maxDimensionPx}px`
        : `${id} ${value}px outside ${config.minDimensionPx}-${config.maxDimensionPx}px`,
    });
  }

  if (config.requireSquare && meta.width !== undefined && meta.height !== undefined) {
    const square = Number.isInteger(meta.width) && meta.width === meta.height;
    checks.push({
      id: 'square',
      passed: square,
      detail: square ? `square (${meta.width}x${meta.height}px)` : `not square (${meta.width}x${meta.height}px); width must equal height`,
    });
  }

  const reasons = checks.filter((c) => !c.passed).map((c) => c.detail);
  return { ok: reasons.length === 0, tier, checks, reasons };
}

/**
 * The format the collection recommends (site rule 1: "Square JPEG format with a minimum size of
 * 200KB"). The other `allowedContentTypes` are accepted; `formatAdvice` phrases the difference.
 */
export const recommendedContentType = 'image/jpeg';

export interface FormatAdvice {
  contentType: string;
  /** `recommended` (JPEG), `accepted` (another allowed type) or `refused`. */
  level: 'recommended' | 'accepted' | 'refused';
  /** One line for the UI. */
  advice: string;
}

/** Advice for a declared content type: JPEG is recommended; PNG/WebP/AVIF/GIF are accepted; anything else refused. */
export function formatAdvice(contentType: string, config: CollectionConfig = DEFAULT_CONFIG): FormatAdvice {
  const type = (contentType ?? '').toLowerCase().trim();
  const others = config.allowedContentTypes.filter((t) => t !== recommendedContentType);
  if (type === recommendedContentType)
    return { contentType: type, level: 'recommended', advice: 'JPEG is the recommended format for a Degent.' };
  if (config.allowedContentTypes.includes(type))
    return {
      contentType: type,
      level: 'accepted',
      advice: `${type} is accepted; JPEG (${recommendedContentType}) is the recommended format.`,
    };
  return {
    contentType: type,
    level: 'refused',
    advice: `${contentType || '(none)'} is not accepted; use ${recommendedContentType} (recommended) or ${others.join(', ')}.`,
  };
}

/** Lowercase hex SHA-256, identical in browser and Node. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

function toBig(v: number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (!Number.isSafeInteger(v)) throw new RangeError(`not an integer sat amount: ${v}`);
  return BigInt(v);
}

/** "12,345 sats" */
export function formatSats(sats: number | bigint): string {
  const v = toBig(sats);
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${digits} ${v === 1n || v === -1n ? 'sat' : 'sats'}`;
}

/** "0.02000546 BTC" (always 8 decimals, exact: no floating point). */
export function formatBtc(sats: number | bigint): string {
  const v = toBig(sats);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac} BTC`;
}

export interface TotalEstimate {
  revealFeeSats: number;
  postageSats: number;
  commitValueSats: number;
  serviceFeeSats: number;
  /** Open Studio artwork orders: club fee (0 on plain orders). */
  clubFeeSats: number;
  /** Open Studio artwork orders: artist royalty (0 on plain orders). */
  artistRoyaltySats: number;
  /** Estimated fee of the user's funding transaction (0 when not provided). */
  fundingFeeSats: number;
  totalSats: number;
}

/**
 * What the user pays in total: commit output (reveal fee + postage) + service fee (plain orders) or club fee
 * + artist royalty (artwork orders, plan §3.1) + funding tx fee. The funding fee depends on the user's
 * wallet UTXOs, so it is an optional estimate.
 */
export function estimateTotal(
  quote: Pick<Quote, 'revealFeeSats' | 'postageSats' | 'serviceFeeSats' | 'commitValueSats' | 'clubFeeSats' | 'artistRoyaltySats'>,
  funding?: { vsize: number; feeRate: number },
): TotalEstimate {
  const fundingFeeSats = funding ? Math.ceil(funding.vsize * funding.feeRate) : 0;
  const commitValueSats = quote.commitValueSats;
  const clubFeeSats = quote.clubFeeSats ?? 0;
  const artistRoyaltySats = quote.artistRoyaltySats ?? 0;
  return {
    revealFeeSats: quote.revealFeeSats,
    postageSats: quote.postageSats,
    commitValueSats,
    serviceFeeSats: quote.serviceFeeSats,
    clubFeeSats,
    artistRoyaltySats,
    fundingFeeSats,
    totalSats: commitValueSats + quote.serviceFeeSats + clubFeeSats + artistRoyaltySats + fundingFeeSats,
  };
}

// ----------------------------------------------------------------------------- Open Studio royalty split

/**
 * Dust limits (sats) of the payout script types the studio accepts (ADR-0007 §3): the smallest output
 * value Bitcoin Core relays for a P2TR / P2WPKH output at the default 3 sat/vB dust fee rate.
 */
export const DUST_LIMIT_SATS: Readonly<Record<PayoutScriptType, number>> = Object.freeze({ p2tr: 330, p2wpkh: 294 });
export type PayoutScriptType = 'p2tr' | 'p2wpkh';

/** Plan defaults (board decisions 2 and 3): royalty 10% of the mint price, club fee 10% of the network cost. */
export const DEFAULT_ROYALTY_BPS = 1000;
export const DEFAULT_CLUB_FEE_BPS = 1000;
export const BPS_DENOMINATOR = 10_000;

export interface RoyaltySplitInput {
  /** Network cost of the reveal: reveal fee + postage (the commit output). */
  commitValueSats: number;
  /** Club fee for the tier, basis points of `commitValueSats`. */
  clubFeeBps: number;
  /** Artist royalty, basis points of the mint price. */
  royaltyBps: number;
  /** Script type of the artist's payout address: decides the dust floor. */
  payoutScriptType: PayoutScriptType;
}

export interface RoyaltySplit {
  commitValueSats: number;
  /** floor(commitValueSats x clubFeeBps / 10,000). */
  clubFeeSats: number;
  /** commitValueSats + clubFeeSats. */
  mintPriceSats: number;
  /** floor(mintPriceSats x royaltyBps / 10,000) before the dust floor. */
  royaltyBeforeDustSats: number;
  /** The royalty actually paid: the raw royalty, raised to the dust limit when it was below it (0 when royaltyBps is 0). */
  artistRoyaltySats: number;
  dustLimitSats: number;
  raisedToDust: boolean;
  /** commitValueSats + clubFeeSats + artistRoyaltySats (funding fee excluded). */
  totalSats: number;
}

function assertBps(v: number, name: string): void {
  if (!Number.isInteger(v) || v < 0 || v > BPS_DENOMINATOR) throw new RangeError(`${name} must be an integer in 0..${BPS_DENOMINATOR}, got ${v}`);
}

/**
 * The Open Studio money split (plan vocabulary; ADR-0007 §5), integer maths only:
 *   clubFee   = floor(commitValue x clubFeeBps / 10,000)
 *   mintPrice = commitValue + clubFee
 *   royalty   = floor(mintPrice x royaltyBps / 10,000), raised to the payout script's dust limit when
 *               positive-but-below-dust (an output below dust would not relay); 0 when royaltyBps is 0
 *   total     = commitValue + clubFee + royalty
 * Pure and deterministic: the browser and the service compute the same numbers from the same quote.
 */
export function computeRoyaltySplit(input: RoyaltySplitInput): RoyaltySplit {
  const { commitValueSats, clubFeeBps, royaltyBps, payoutScriptType } = input;
  if (!Number.isSafeInteger(commitValueSats) || commitValueSats < 0) throw new RangeError(`commitValueSats must be a non-negative integer, got ${commitValueSats}`);
  assertBps(clubFeeBps, 'clubFeeBps');
  assertBps(royaltyBps, 'royaltyBps');
  const dustLimitSats = DUST_LIMIT_SATS[payoutScriptType];
  if (dustLimitSats === undefined) throw new RangeError(`unknown payout script type ${String(payoutScriptType)}`);
  const clubFeeSats = Math.floor((commitValueSats * clubFeeBps) / BPS_DENOMINATOR);
  const mintPriceSats = commitValueSats + clubFeeSats;
  const royaltyBeforeDustSats = Math.floor((mintPriceSats * royaltyBps) / BPS_DENOMINATOR);
  const raisedToDust = royaltyBps > 0 && royaltyBeforeDustSats < dustLimitSats;
  const artistRoyaltySats = royaltyBps === 0 ? 0 : raisedToDust ? dustLimitSats : royaltyBeforeDustSats;
  return {
    commitValueSats,
    clubFeeSats,
    mintPriceSats,
    royaltyBeforeDustSats,
    artistRoyaltySats,
    dustLimitSats,
    raisedToDust,
    totalSats: commitValueSats + clubFeeSats + artistRoyaltySats,
  };
}

/** Block lane ETA: block slot x ~10 minutes. */
export function etaMinutesForPosition(position: number | null): number | null {
  return position === null ? null : position * BLOCK_INTERVAL_MINUTES;
}

export function isTier(v: unknown): v is Tier {
  return v === 'standard' || v === 'large' || v === 'fullblock';
}
