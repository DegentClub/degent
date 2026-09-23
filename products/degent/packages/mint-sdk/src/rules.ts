/**
 * degent.club mint rules shared by the browser and the service (ADR-0002 §1, §5).
 * Pure functions only: no I/O, no network, safe to run in either environment.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CollectionConfig, Quote, ReviewCheck, Tier, TierRule } from './types.js';

export const STANDARD_MIN_BYTES = 200_000;
export const STANDARD_MAX_BYTES = 390_000;
export const BLOCK_MIN_BYTES = 390_001;
export const BLOCK_MAX_BYTES = 3_900_000;
/** Largest request body the service accepts for PUT /content (4 MiB). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Block Degents are one per block; ETA is position x ~10 minutes, never a promise. */
export const BLOCK_INTERVAL_MINUTES = 10;

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
      label: 'Standard Degent',
      description: 'Up to ~390 KB. Standard reveal (<= 400,000 WU), relayed by the normal mempool, many per block.',
    },
    {
      tier: 'block',
      minBytes: BLOCK_MIN_BYTES,
      maxBytes: BLOCK_MAX_BYTES,
      lane: 'block',
      label: 'Block Degent',
      description:
        'Up to ~3.9 MB. Non-standard reveal relayed via Libre Relay / Slipstream. One per block: expect a queue.',
    },
  ] satisfies TierRule[],
  maxDimensionPx: 4096,
  minDimensionPx: 256,
  postageSats: 546,
  serviceFeeSats: { standard: 0, block: 0 },
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

  const reasons = checks.filter((c) => !c.passed).map((c) => c.detail);
  return { ok: reasons.length === 0, tier, checks, reasons };
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
  /** Estimated fee of the user's funding transaction (0 when not provided). */
  fundingFeeSats: number;
  totalSats: number;
}

/**
 * What the user pays in total: commit output (reveal fee + postage) + service fee + funding tx fee.
 * The funding fee depends on the user's wallet UTXOs, so it is an optional estimate.
 */
export function estimateTotal(
  quote: Pick<Quote, 'revealFeeSats' | 'postageSats' | 'serviceFeeSats' | 'commitValueSats'>,
  funding?: { vsize: number; feeRate: number },
): TotalEstimate {
  const fundingFeeSats = funding ? Math.ceil(funding.vsize * funding.feeRate) : 0;
  const commitValueSats = quote.commitValueSats;
  return {
    revealFeeSats: quote.revealFeeSats,
    postageSats: quote.postageSats,
    commitValueSats,
    serviceFeeSats: quote.serviceFeeSats,
    fundingFeeSats,
    totalSats: commitValueSats + quote.serviceFeeSats + fundingFeeSats,
  };
}

/** Block lane ETA: position x ~10 minutes. */
export function etaMinutesForPosition(position: number | null): number | null {
  return position === null ? null : position * BLOCK_INTERVAL_MINUTES;
}
