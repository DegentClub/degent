/**
 * Shared domain types for the degent.club mint. Mirrors contracts/openapi/degent-mint.yaml.
 * Used by both the front end (@bsh/degent-web) and the service (@bsh/degent-mint) so that
 * what the user sees is computed from the same definitions the service enforces.
 *
 * Wire conventions: amounts are integer sats as JSON numbers (all mint amounts are far below
 * 2^53), timestamps are ISO 8601 UTC strings, hashes and keys are lowercase hex.
 */

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

/**
 * Tiers are a PRODUCT decision on CONTENT BYTES (ADR-0005 §3): Standard Degent, Large Degent,
 * Full Block Degent. Lanes are TRANSPORT, decided by the reveal's WEIGHT (`laneForWeight`): a
 * Standard Degent near the top of its byte range can weigh more than 400,000 WU and then travels
 * the block lane. The binding quote's `lane` is authoritative.
 */
export type Tier = 'standard' | 'large' | 'fullblock';
export type Lane = 'standard' | 'block';

export const TIERS: readonly Tier[] = ['standard', 'large', 'fullblock'];

export const ORDER_STATUSES = [
  'awaiting_content',
  'reviewing',
  'approved',
  'rejected',
  'awaiting_payment',
  'paid',
  'queued',
  'revealing',
  'revealed',
  'confirmed',
  'verified',
  'delivered',
  'expired',
  'rescue_available',
  'failed',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface TierRule {
  tier: Tier;
  /** Minimum content size in bytes (inclusive). */
  minBytes: number;
  /** Maximum content size in bytes (inclusive). */
  maxBytes: number;
  /**
   * The lane content of this tier USUALLY travels. Not binding: the quote's `lane` is decided by
   * the reveal weight (standard <= 400,000 WU, else block).
   */
  lane: Lane;
  /** Full Block Degents always take a block alone; the others may share a block's weight budget. */
  sharesBlock: boolean;
  label: string;
  description: string;
}

export interface CollectionConfig {
  network: Network;
  collectionName: string;
  parentInscriptionId: string | null;
  allowedContentTypes: string[];
  tiers: TierRule[];
  maxDimensionPx: number;
  minDimensionPx: number;
  /**
   * Require width === height when dimensions are known (Degent rule 1, "Square JPEG"). Optional and
   * off in DEFAULT_CONFIG so existing callers keep their behaviour; the studio turns it on
   * (`DEGENT_RULES_CONFIG`). When on, `validateContentMeta` adds a `square` check.
   */
  requireSquare?: boolean;
  postageSats: number;
  serviceFeeSats: Record<Tier, number>;
  minFeeRate: number; // sat/vB
  quoteTtlSeconds: number;
  rescueAfterSeconds: number;
}

/** GET /v1/config: the collection rules plus the addresses and constants the front end needs. */
export interface ServiceConfig extends CollectionConfig {
  /** Taproot address holding the parent inscription; output 0 of every reveal returns it here. */
  collectionAddress: string;
  /**
   * The parent UTXO's constant value in sats. The browser pre-commits output 0 = (collectionAddress,
   * parentValueSats) when it signs the reveal with SIGHASH_ALL|ANYONECANPAY (ADR-0005 §1).
   */
  parentValueSats: number;
  serviceFeeAddress: string | null;
  maxUploadBytes: number;
  /**
   * Open Studio (ADR-0007, plan §3.1): artist royalty in basis points of the mint price
   * (`commitValueSats + clubFeeSats`), paid as an output of the minter's funding transaction to the
   * artist's proven payout address. Default 1000 (10%). Absent on services without a studio.
   */
  royaltyBps?: number;
  /** Open Studio: club fee per tier in basis points of `commitValueSats`, paid to `serviceFeeAddress`. Default 1000. */
  clubFeeBps?: Record<Tier, number>;
  /** Base URL of the Artist Studio the mint takes artworks from; null when artwork orders are disabled. */
  studioUrl?: string | null;
}

export interface CreateOrderRequest {
  tier: Tier;
  contentType: string;
  contentLength: number;
  contentSha256: string; // lowercase hex
  recipientAddress: string; // ordinals (taproot) address receiving the child
  revealPubkey: string; // 32-byte x-only hex, ephemeral, generated in the browser
  feeRate: number; // sat/vB
  /**
   * Open Studio: mint an approved studio artwork. `contentType`, `contentLength` and `contentSha256` must
   * equal the artwork record's (the service takes the facts and the bytes from the studio); the upload step
   * is skipped and the order is returned already `approved` with a binding quote (plan §3.1).
   */
  artworkId?: string;
}

export interface Quote {
  tier: Tier;
  /** Transport lane decided by `revealWeight` (ADR-0005 §3), not by the tier. */
  lane: Lane;
  feeRate: number;
  revealWeight: number;
  revealVsize: number;
  revealFeeSats: number;
  postageSats: number;
  serviceFeeSats: number;
  commitValueSats: number; // revealFee + postage (goes to commit address)
  totalSats: number; // commitValue + serviceFee (+ funding tx fee estimated separately by the wallet)
  /** Null on the indicative quote (content not uploaded yet); set on the binding quote. */
  commitAddress: string | null;
  /** False: indicative (from declared size, POST /v1/orders). True: binding (after PUT content). */
  binding: boolean;
  expiresAt: string; // ISO 8601
  /** Block lane only: the 1-based block slot this order would be revealed in (ADR-0005 §4). */
  queuePosition: number | null;
  etaMinutes: number | null;
  // ---- Open Studio artwork orders (ADR-0007 §5, plan §3.1). Absent on plain orders. ----
  /** Club fee: floor(commitValueSats x clubFeeBps / 10,000) for the tier; output [2] of the funding tx to serviceFeeAddress. Replaces the flat serviceFeeSats (0 on artwork orders). */
  clubFeeSats?: number;
  /** Artist royalty: floor(mintPriceSats x royaltyBps / 10,000), raised to the dust limit of the payout script type; output [1] of the funding tx. */
  artistRoyaltySats?: number;
  /** The artist's proven payout address (from the studio); the royalty output's destination. */
  artistAddress?: string;
  artworkId?: string;
  /** commitValueSats + clubFeeSats: the base of the royalty. */
  mintPriceSats?: number;
  /** The edition number reserved for this order until `expiresAt`; the browser signs the reveal's attribution metadata with it (plan §3.4). */
  edition?: number;
  /** True when the royalty was below the payout script's dust limit and was raised to it (plan §3.2). */
  royaltyRaisedToDust?: boolean;
}

export interface ReviewCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ReviewResult {
  approved: boolean;
  reasons: string[];
  checks: ReviewCheck[];
}

export interface OrderEvent {
  status: OrderStatus;
  at: string; // ISO 8601
  detail?: string;
  txid?: string;
}

export interface QueueInfo {
  lane: Lane;
  /**
   * Block lane: the 1-based block SLOT (several Large Degents can share one slot within the
   * 3,990,000 WU budget; a Full Block Degent has a slot to itself). Standard lane: position among
   * waiting orders. Null once revealing or later.
   */
  position: number | null;
  etaMinutes: number | null;
}

/** The artist royalty output as found in the minter's funding transaction (plan §3.3). */
export interface RoyaltyPaid {
  txid: string;
  vout: number;
  sats: number;
}

export interface Order {
  id: string;
  network: Network;
  status: OrderStatus;
  tier: Tier;
  contentType: string;
  contentLength: number;
  contentSha256: string;
  recipientAddress: string;
  revealPubkey: string;
  quote: Quote | null;
  review: ReviewResult | null;
  commitOutpoint: { txid: string; vout: number } | null;
  revealTxid: string | null;
  inscriptionId: string | null;
  /** True when the child landed without the parent link (self-rescue path). */
  rescued: boolean;
  serviceFeeAddress: string | null;
  queue: QueueInfo | null;
  timeline: OrderEvent[];
  createdAt: string;
  updatedAt: string;
  // ---- Open Studio artwork orders (plan §3.1). Absent on plain orders. ----
  artworkId?: string;
  artistAddress?: string;
  artistRoyaltySats?: number;
  clubFeeSats?: number;
  /** Assigned when the order reaches `paid` (the reservation made at quote time becomes the edition). */
  edition?: number;
  /** The verified royalty output of the funding transaction; null until `paid`. */
  royaltyPaid?: RoyaltyPaid | null;
}

/**
 * POST /v1/orders response. `orderToken` is a random 256-bit bearer secret returned ONCE (the
 * service stores only its SHA-256). It authorises PUT /content, POST /reveal and GET /rescue for
 * this order. Keep it with the local recovery bundle; it cannot be recovered from the service.
 */
export interface CreateOrderResponse {
  order: Order;
  orderToken: string;
}

export interface SubmitRevealRequest {
  commitTxid: string;
  commitVout: number;
  /**
   * base64 PSBT: `[commit] -> [parent return, child]`, commit input signed with
   * SIGHASH_ALL|ANYONECANPAY (0x81). Output 0 must be (collectionAddress, parentValueSats) from
   * GET /v1/config; the service inserts the parent input at index 0 later (ADR-0005 §1).
   */
  halfSignedRevealPsbt: string;
  /** Optional: the commit address the browser computed. Rejected if it differs from the service's. */
  commitAddress?: string;
}

/**
 * GET /v1/orders/{id}/rescue (ADR-0005 §2). The service no longer returns a transaction: a 0x81
 * half-signed reveal cannot be broadcast without the parent. Instead it returns everything the
 * browser needs to re-sign `[commit] -> [child]` locally with the ephemeral key K_e kept in the
 * user's recovery bundle (`@bsh/inscription.buildResignedRescue`). The content bytes themselves
 * are in the bundle (or still in memory); their hash is here so the browser can check them.
 */
export interface RescueInputs {
  orderId: string;
  network: Network;
  commitTxid: string;
  commitVout: number;
  commitValueSats: number;
  contentType: string;
  contentLength: number;
  contentSha256: string;
  /** Envelope parent tag (tag 3) the commit was built with; null when the collection has none. */
  parentInscriptionId: string | null;
  recipientAddress: string;
  /** x-only hex of K_e: the browser must hold the matching private key. */
  revealPubkey: string;
  postageSats: number;
  /** Exact weight of the re-signed rescue transaction (`estimateResignedRescueWeight`). */
  rescueWeight: number;
  /** commitValue - postage: the whole remainder is the fee (no change output). */
  rescueFeeSats: number;
  /** rescueFeeSats / ceil(rescueWeight / 4): what the rescue pays, sat/vB. */
  rescueFeeRate: number;
  /** The service's current standard-lane estimate, so the UI can say whether the rescue is competitive. */
  suggestedFeeRate: number;
  // ---- Open Studio artwork orders: the attribution the envelope was built with (plan §3.4, §3.6). ----
  artworkId?: string;
  artistAddress?: string;
  edition?: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  network: Network;
  version: string;
  time: string;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface FeesResponse {
  network: Network;
  minFeeRate: number;
  standard: { slow: number; normal: number; fast: number };
  block: { min: number; recommended: number };
  fetchedAt: string;
}

export interface LaneQueue {
  lane: Lane;
  waiting: number;
  inFlight: number;
  /** Standard: reveals in flight allowed. Block: blocks in flight (always 1). */
  capacity: number;
  /** Block lane: the per-block weight budget (WU); null for the standard lane. */
  weightBudget: number | null;
  /** Block lane: weight (WU) of the reveals currently in flight; 0 for the standard lane. */
  inFlightWeight: number;
  etaMinutesForNext: number | null;
}

export interface QueueResponse {
  standard: LaneQueue;
  block: LaneQueue;
  tipHeight: number | null;
}

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'quote_expired'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'forbidden_origin'
  | 'content_mismatch'
  | 'reveal_invalid'
  | 'rescue_unavailable'
  | 'review_unavailable'
  | 'queue_full'
  | 'upstream_unavailable'
  | 'internal'
  | 'artwork_not_found'
  | 'artwork_not_mintable'
  | 'artist_payout_missing';

export interface ApiErrorBody {
  error: { code: ApiErrorCode | string; message: string; details?: unknown };
}

/** Payload of every `degent.mint.order.{status}` event (contracts/asyncapi/degent-mint.yaml). */
export interface OrderStatusEvent {
  type: `degent.mint.order.${OrderStatus}`;
  eventId: string;
  orderId: string;
  network: Network;
  status: OrderStatus;
  previousStatus: OrderStatus | null;
  at: string;
  lane: Lane;
  detail?: string;
  txid?: string;
  inscriptionId?: string;
}

/**
 * Payload of `degent.mint.royalty.paid` (contracts/asyncapi/degent-mint.yaml): the artist royalty output
 * of the minter's funding transaction was verified by script and value. Emitted once per artwork order,
 * after the funding transaction is final (confirmed, or unconfirmed and not RBF-signalling).
 */
export interface RoyaltyPaidEvent {
  type: 'degent.mint.royalty.paid';
  /** `<orderId>:royalty`. Idempotency key. */
  eventId: string;
  orderId: string;
  network: Network;
  artworkId: string;
  /** The artist's payout address (the output's destination). */
  artist: string;
  sats: number;
  txid: string;
  vout: number;
  at: string;
  edition?: number;
}
