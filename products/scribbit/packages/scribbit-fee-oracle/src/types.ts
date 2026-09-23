/**
 * Public types of the scribb.it fee oracle. The HTTP shapes mirror contracts/openapi/scribbit-fees.yaml.
 *
 * `FeesResponse` is a superset of the degent.club mint `FeesResponse` ({ network, minFeeRate,
 * standard:{slow,normal,fast}, block:{min,recommended}, fetchedAt }): the extra fields (`stale`,
 * `sources`) are additive, so a degent-shaped client can consume it unchanged. The shape is
 * replicated here (not imported) because products never import each other's code.
 *
 * Units: every fee rate is sat/vB as a JSON number (may be fractional); timestamps are ISO 8601 UTC.
 */

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';
export const NETWORKS: readonly Network[] = Object.freeze(['mainnet', 'testnet', 'signet', 'regtest']);
export const isNetwork = (s: unknown): s is Network => typeof s === 'string' && (NETWORKS as readonly string[]).includes(s);

/** Confirmation targets (blocks) every source is normalised to. */
export const TARGETS = Object.freeze([1, 3, 6, 144] as const);
export type Target = (typeof TARGETS)[number];

export type SourceKind = 'mempool-recommended' | 'mempool-blocks' | 'esplora' | 'bitcoind' | 'block-lane' | 'static';

/** What one source said, normalised to sat/vB. Every field is optional: sources report what they know. */
export interface SourceReading {
  /** Confirmation target (blocks) -> sat/vB. */
  targets?: Partial<Record<Target, number>>;
  /** The standard-relay floor this source observes (e.g. mempool `minimumFee`, bitcoind `mempoolminfee`). */
  minRelay?: number;
  /** Block-lane (non-standard, block-sized transactions) view. */
  block?: { min?: number; recommended?: number };
}

/** A fee source port. Adapters in ./sources implement it over an injectable `fetch`. */
export interface FeeSource {
  readonly id: string;
  readonly kind: SourceKind;
  fetch(signal: AbortSignal): Promise<SourceReading>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface StandardFees {
  slow: number;
  normal: number;
  fast: number;
}

export interface BlockLaneFees {
  /** Lowest rate the block lane accepts (lane floor, never below `minFeeRate` policy for the lane). */
  min: number;
  /** Suggested rate for a block-sized reveal to be mined promptly. */
  recommended: number;
}

/** GET /v1/fees */
export interface FeesResponse {
  network: Network;
  /** Floor for any quote: max(configured min relay, median observed standard-relay floor). */
  minFeeRate: number;
  standard: StandardFees;
  block: BlockLaneFees;
  /** When the aggregate was assembled from upstream readings (not when it was served). */
  fetchedAt: string;
  /** True when served past its TTL because every refresh since has failed. */
  stale: boolean;
  /** Ids of the sources that contributed at least one accepted value. */
  sources: string[];
}

export interface SourceHealth {
  id: string;
  kind: SourceKind;
  /** Last attempt succeeded. */
  ok: boolean;
  /** No success within `staleAfterMs` (or never). */
  stale: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  /** Values rejected as outliers in the last aggregation, e.g. ["target:1", "block.recommended"]. */
  outliers: string[];
  /** Last successful reading (sat/vB), for debugging. */
  lastReading: SourceReading | null;
}

/** GET /v1/fees/sources */
export interface SourcesHealthResponse {
  network: Network;
  /** ok: every source healthy; degraded: some; down: none. */
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  sources: SourceHealth[];
}

/** Maps the three standard tiers to confirmation targets. */
export interface TierTargets {
  fast: Target;
  normal: Target;
  slow: Target;
}

/** Block-lane policy (non-standard transactions up to ~4 MWU, relayed via Libre Relay / Slipstream). */
export interface LanePolicy {
  /** Lane floor in sat/vB. Default 1. The response's `block.min` is never below this or `minRelayFeeRate`. */
  minFeeRate: number;
  /**
   * Target whose aggregated standard rate the recommendation falls back to when no source reports a
   * block-lane recommendation. Default 1 (a block-sized tx displaces most of the next block).
   */
  recommendedTarget: Target;
  /** Multiplier applied to the recommendation (margin for displacing a whole block). Default 1. */
  premium: number;
  /** Hard cap in sat/vB for `block.recommended`. Default 500. */
  maxFeeRate: number;
}

export interface OutlierPolicy {
  /** Reject values further than k × 1.4826 × MAD from the median. Default 3. */
  madK: number;
  /** ... but never reject values within this relative distance of the median. Default 0.25 (25 %). */
  minRelSpread: number;
}

export interface AggregateConfig {
  /** Configured min relay fee rate (sat/vB). Default 1. */
  minRelayFeeRate: number;
  tiers: TierTargets;
  lane: LanePolicy;
  outliers: OutlierPolicy;
  /** Round every output rate UP to this step (sat/vB). Default 0.1. */
  step: number;
}

export const DEFAULT_AGGREGATE_CONFIG: AggregateConfig = Object.freeze({
  minRelayFeeRate: 1,
  tiers: Object.freeze({ fast: 1, normal: 3, slow: 144 }) as TierTargets,
  lane: Object.freeze({ minFeeRate: 1, recommendedTarget: 1, premium: 1, maxFeeRate: 500 }) as LanePolicy,
  outliers: Object.freeze({ madK: 3, minRelSpread: 0.25 }) as OutlierPolicy,
  step: 0.1,
}) as AggregateConfig;

/** Error body used by the server (contracts/openapi/scribbit-fees.yaml#/components/schemas/Error). */
export interface ApiErrorBody {
  error: { code: 'bad_request' | 'not_found' | 'fees_unavailable' | 'internal'; message: string; details?: unknown };
}
