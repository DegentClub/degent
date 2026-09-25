/**
 * Internal order record: the public `Order` plus fields that never leave the service
 * (token hash, raw reveal hex, lease bookkeeping, optimistic-concurrency version).
 *
 * The half-signed reveal PSBT is deliberately NOT part of this record: it lives encrypted in the
 * separate RevealVault (ports/reveal-vault.ts) and is never logged, emitted or returned. (With
 * 0x81 a holder can no longer restructure it, ADR-0005; keeping it out of the row and out of every
 * response is still the cheapest way to make sure a leak of the orders table leaks nothing else.)
 */
import type { Lane, Order, OrderStatus, QueueInfo } from '@bsh/degent-mint-sdk';

/** Bookkeeping for the studio royalty record (plan §3.3: retry with backoff, idempotent on orderId). */
export interface RoyaltyReportState {
  /** `degent.mint.royalty.paid` published. */
  emittedAt: string | null;
  /** `POST /v1/internal/royalties` acknowledged. */
  reportedAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** The studio refused the record for good (e.g. conflicting facts); an operator must look. */
  gaveUp: boolean;
}

/** Bookkeeping for the ledger order + psbt intent (plan §3.5; never blocks the mint). */
export interface LedgerRecordState {
  orderId: string | null;
  paymentId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** The funding transaction was reported (`POST /v1/payments/{id}/observations`); set once at >= 1 confirmation. */
  observedAt?: string | null;
  /** True when the observation that was reported was already confirmed (nothing more to report). */
  observedConfirmed?: boolean;
}

export interface OrderRecord extends Omit<Order, 'queue'> {
  lane: Lane;
  /** Optimistic concurrency: incremented on every save; stores reject stale writes. */
  version: number;
  /** When the current quote/phase expires (awaiting_content, approved, awaiting_payment). */
  expiresAt: string;
  /** SHA-256 hex of the order's bearer token (the token itself is returned once, never stored). */
  orderTokenHash: string;
  /** True once a verified half-signed reveal is stored in the RevealVault. */
  hasReveal: boolean;
  paidAt: string | null;
  /** Monotonic lane ordering key assigned when queued (paidAt ms, then id). */
  queuedAt: string | null;
  revealHex: string | null;
  revealWeight: number | null;
  broadcastAttempts: number;
  lastError: string | null;
  /** Parent outpoint this order's reveal spends (set while revealing / after). */
  parentOutpoint: { txid: string; vout: number } | null;
  // ---- Open Studio artwork orders (absent / undefined on plain orders and on rows written before Phase 3) ----
  /**
   * Funding tx was unconfirmed when the payment was detected (whatever it signalled: full-RBF makes every
   * unconfirmed tx replaceable in practice, security review p5.5); the royalty report waits for finality.
   */
  fundingRbf?: boolean;
  royaltyReport?: RoyaltyReportState | null;
  ledger?: LedgerRecordState | null;
}

export const isArtworkOrder = (r: Pick<OrderRecord, 'artworkId'>): boolean => typeof r.artworkId === 'string' && r.artworkId.length > 0;

/** Public projection. Never includes the PSBT, raw hex or internal bookkeeping. */
export function toPublicOrder(r: OrderRecord, queue: QueueInfo | null): Order {
  return {
    id: r.id,
    network: r.network,
    status: r.status,
    tier: r.tier,
    contentType: r.contentType,
    contentLength: r.contentLength,
    contentSha256: r.contentSha256,
    recipientAddress: r.recipientAddress,
    revealPubkey: r.revealPubkey,
    quote: r.quote,
    review: r.review,
    commitOutpoint: r.commitOutpoint,
    revealTxid: r.revealTxid,
    inscriptionId: r.inscriptionId,
    rescued: r.rescued,
    serviceFeeAddress: r.serviceFeeAddress,
    queue,
    timeline: r.timeline,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(isArtworkOrder(r)
      ? {
          artworkId: r.artworkId,
          artistAddress: r.artistAddress,
          artistRoyaltySats: r.artistRoyaltySats,
          clubFeeSats: r.clubFeeSats,
          ...(r.edition !== undefined ? { edition: r.edition } : {}),
          royaltyPaid: r.royaltyPaid ?? null,
        }
      : {}),
  };
}

/** Orders the worker still has to watch. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  'awaiting_content',
  'reviewing',
  'approved',
  'awaiting_payment',
  'paid',
  'queued',
  'revealing',
  'revealed',
  'confirmed',
  'verified',
  'rescue_available',
];

/** States in which an order occupies (or waits for) a lane slot. */
export const WAITING_FOR_LANE: readonly OrderStatus[] = ['paid', 'queued'];
export const IN_FLIGHT: readonly OrderStatus[] = ['revealing', 'revealed'];
