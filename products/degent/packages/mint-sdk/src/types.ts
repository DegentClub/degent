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
  'confirming',
  'member_review',
  'declined',
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
  /** Public member-approval tally (ADR-0005). Null before the commit is confirmed. */
  approval: ApprovalInfo | null;
  /** Degent number assigned when the members approved (4112 + rank). Null until then. */
  degentNumber: number | null;
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
  | 'not_a_holder'
  | 'already_voted'
  | 'self_vote'
  | 'vote_invalid'
  | 'auth_failed'
  | 'review_closed'
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

// ---------------------------------------------------------------- member approval (ADR-0005)

export type VoteChoice = 'approve' | 'decline';

/** Public tally shown on the order and the review queue. Counts only; never voter addresses. */
export interface ApprovalInfo {
  approvals: number;
  declines: number;
  approvalQuorum: number;
  declineQuorum: number;
  /** When member_review started (ISO 8601); the review SLA counts from here. */
  reviewStartedAt: string | null;
  /** When the SLA lapses and self-rescue is offered instead (ISO 8601). */
  reviewDeadline: string | null;
}

/** One member's vote as stored and as returned by GET /v1/orders/{id}/votes (address omitted). */
export interface PublicVote {
  /** Degent number the voter voted with (their membership), never their address. */
  degent: number;
  vote: VoteChoice;
  at: string;
  /** BIP-322 simple signature (base64) over `message`, so anyone can verify the vote. */
  signature: string;
  message: string;
}

export interface VotesResponse {
  orderId: string;
  status: OrderStatus;
  approval: ApprovalInfo;
  votes: PublicVote[];
}

export interface CastVoteRequest {
  vote: VoteChoice;
  /** Exactly `voteStatement(vote, orderId, ref)`; the service rebuilds and compares it. */
  message: string;
  /** BIP-322 simple signature (base64) of `message` by the holder's address. */
  signature: string;
}

/** What a reviewer sees in the queue: the public order plus its tally. */
export interface ReviewItem {
  order: Order;
  approval: ApprovalInfo;
  /** True when the signed-in member has already voted on this order. */
  voted: VoteChoice | null;
}

export interface ReviewQueueResponse {
  items: ReviewItem[];
  /** Degent numbers the signed-in member holds. */
  memberDegents: number[];
}

// ---------------------------------------------------------------- holder auth (SIWB via @bsh/identity)

export interface AuthChallengeRequest {
  address: string;
}

export interface AuthChallengeResponse {
  /** SIWB message to sign with the wallet (BIP-322 simple). */
  message: string;
  expiresAt: string;
}

export interface AuthVerifyRequest {
  address: string;
  message: string;
  signature: string;
}

export interface AuthVerifyResponse {
  /** Bearer session token (compact JWS). Send as `Authorization: Bearer <token>`. */
  token: string;
  address: string;
  degents: number[];
  expiresAt: string;
}

// ---------------------------------------------------------------- register, explorer, stats

export type MembershipVia = 'gallery' | 'child';

export interface RegisterMember {
  n: number;
  id: string;
  /** Global inscription number when known. */
  number: number | null;
  via: MembershipVia;
  bytes: number;
  height: number | null;
  sat: number | null;
  owner: string | null;
  /** ord content URL (rendering) for the explorer grid. */
  contentUrl: string;
}

export interface RegisterSummary {
  parent: string | null;
  gallery: string | null;
  count: number;
  bytes: number;
  /** Members approved by vote but not yet delivered on chain (pending children). */
  pending: number;
  updatedAt: string;
}

export interface HolderResponse {
  address: string;
  holder: boolean;
  degents: number[];
}

export interface VerifyMembershipResponse {
  id: string;
  member: boolean;
  via: MembershipVia | null;
  n: number | null;
}

export type ExplorerSort = 'n' | 'bytes' | 'height';

export interface ExplorerQuery {
  offset?: number;
  limit?: number;
  sort?: ExplorerSort;
  order?: 'asc' | 'desc';
  /** Matches a Degent number, an inscription id prefix or an owner address prefix. */
  q?: string;
}

export interface ExplorerResponse {
  items: RegisterMember[];
  total: number;
  offset: number;
  limit: number;
  sort: ExplorerSort;
  order: 'asc' | 'desc';
}

export interface HistogramBucket {
  /** Inclusive lower bound of the bucket, in the unit of the series. */
  from: number;
  /** Exclusive upper bound; null for the last, open bucket. */
  to: number | null;
  count: number;
}

export interface WeekBucket {
  /** ISO date (Monday) of the week. */
  week: string;
  count: number;
}

export interface StatsResponse {
  minted: number;
  charter: number;
  totalBytes: number;
  medianBytes: number;
  /** Members with a known timestamp bucketed per ISO week; empty when heights are unknown. */
  mintsPerWeek: WeekBucket[];
  sizeHistogram: HistogramBucket[];
  approvals: {
    inReview: number;
    approved: number;
    declined: number;
    /** Approved orders per ISO week. */
    perWeek: WeekBucket[];
    /** Median seconds from member_review to the approval quorum, null when nothing was approved yet. */
    medianSecondsToQuorum: number | null;
  };
  topHolders: Array<{ owner: string; count: number }>;
  updatedAt: string;
}
