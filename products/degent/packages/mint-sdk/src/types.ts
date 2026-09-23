/**
 * Shared domain types for the degent.club mint. Mirrors contracts/openapi/degent-mint.yaml.
 * Used by both the front end (@bsh/degent-web) and the service (@bsh/degent-mint) so that
 * what the user sees is computed from the same definitions the service enforces.
 *
 * Wire conventions: amounts are integer sats as JSON numbers (all mint amounts are far below
 * 2^53), timestamps are ISO 8601 UTC strings, hashes and keys are lowercase hex.
 */

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';
export type Tier = 'standard' | 'block';
export type Lane = 'standard' | 'block';

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
  lane: Lane;
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
  postageSats: number;
  serviceFeeSats: { standard: number; block: number };
  minFeeRate: number; // sat/vB
  quoteTtlSeconds: number;
  rescueAfterSeconds: number;
}

/** GET /v1/config: the collection rules plus the addresses the front end needs to show. */
export interface ServiceConfig extends CollectionConfig {
  collectionAddress: string;
  serviceFeeAddress: string | null;
  maxUploadBytes: number;
}

export interface CreateOrderRequest {
  tier: Tier;
  contentType: string;
  contentLength: number;
  contentSha256: string; // lowercase hex
  recipientAddress: string; // ordinals (taproot) address receiving the child
  revealPubkey: string; // 32-byte x-only hex, ephemeral, generated in the browser
  feeRate: number; // sat/vB
}

export interface Quote {
  tier: Tier;
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
  queuePosition: number | null; // block lane only
  etaMinutes: number | null;
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
  /** 1-based position among orders waiting for this lane; null once revealing or later. */
  position: number | null;
  etaMinutes: number | null;
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
  halfSignedRevealPsbt: string; // base64 PSBT, input 1 signed with 0x83
  /** Optional: the commit address the browser computed. Rejected if it differs from the service's. */
  commitAddress?: string;
}

export interface RescueResponse {
  orderId: string;
  txid: string;
  hex: string;
  weight: number;
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
  capacity: number;
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
  | 'review_rejected'
  | 'reveal_invalid'
  | 'rescue_unavailable'
  | 'internal';

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
