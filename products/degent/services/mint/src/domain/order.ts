/**
 * Internal order record: the public `Order` plus fields that never leave the service
 * (half-signed PSBT, raw reveal hex, lease bookkeeping, optimistic-concurrency version).
 */
import type { Lane, Order, OrderStatus, QueueInfo } from '@bsh/degent-mint-sdk';

export interface OrderRecord extends Omit<Order, 'queue'> {
  lane: Lane;
  /** Optimistic concurrency: incremented on every save; stores reject stale writes. */
  version: number;
  /** When the current quote/phase expires (awaiting_content, approved, awaiting_payment). */
  expiresAt: string;
  halfSignedPsbt: string | null;
  paidAt: string | null;
  /** Monotonic lane ordering key assigned when queued (paidAt ms, then id). */
  queuedAt: string | null;
  revealHex: string | null;
  revealWeight: number | null;
  broadcastAttempts: number;
  lastError: string | null;
  /** Parent outpoint this order's reveal spends (set while revealing / after). */
  parentOutpoint: { txid: string; vout: number } | null;
}

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
