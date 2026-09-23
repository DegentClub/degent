/**
 * Order state machine (ADR-0002 §6). Pure: no I/O, no clock. The table is the single source of
 * truth for which transitions exist; everything else in the service goes through `transition`.
 *
 *   awaiting_content -> reviewing -> approved | rejected
 *   approved -> awaiting_payment (half-signed reveal verified + stored)
 *   awaiting_payment -> paid (commit seen) -> confirming (commit unconfirmed)
 *   confirming -> member_review (commit confirmed; existing members vote, ADR-0005)
 *   member_review -> queued (approval quorum; Degent number assigned) | declined (decline quorum)
 *   queued (lane) -> revealing -> revealed (mempool)
 *   revealed -> confirmed -> verified (ord content hash matches) -> delivered
 *   any pre-paid state -> expired
 *   paid | confirming | queued | revealing -> rescue_available (after rescueAfterSeconds)
 *   member_review -> rescue_available (after the review SLA, reviewSlaSeconds: no funds stranded)
 *   declined -> revealed (the user self-rescued: inscription without the parent, not a Degent)
 *
 * Service-specific edges beyond the ADR diagram, each with a reason:
 *   revealing -> queued          broadcast failed; parent lease released, retried next tick
 *   awaiting_payment -> failed   commit output funded with the wrong value/script (unspendable by us)
 *   revealing -> rescue_available also used immediately when the policy signer refuses the
 *                                transaction: the user's commit is intact, so self-rescue is offered
 *   confirmed -> failed          ord returned different bytes than were uploaded
 *   expired -> paid              a quote expired but the commit was funded anyway (fee is fixed in
 *                                the commit value, so honouring a late payment is always safe)
 *   rescue_available -> revealed the commit was spent on chain (user self-rescue or a late reveal)
 */
import type { OrderStatus } from '@bsh/degent-mint-sdk';

export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = Object.freeze({
  awaiting_content: ['reviewing', 'expired'],
  reviewing: ['approved', 'rejected', 'expired'],
  approved: ['awaiting_payment', 'expired'],
  rejected: [],
  awaiting_payment: ['paid', 'expired', 'failed'],
  paid: ['confirming', 'rescue_available'],
  confirming: ['member_review', 'rescue_available'],
  member_review: ['queued', 'declined', 'rescue_available'],
  declined: ['revealed'],
  queued: ['revealing', 'rescue_available'],
  revealing: ['revealed', 'queued', 'rescue_available'],
  revealed: ['confirmed'],
  confirmed: ['verified', 'failed'],
  verified: ['delivered'],
  delivered: [],
  expired: ['paid'],
  rescue_available: ['revealed'],
  failed: [],
});

/** States in which the user has not paid yet (ADR: "any pre-paid state -> expired"). */
export const PRE_PAID: readonly OrderStatus[] = ['awaiting_content', 'reviewing', 'approved', 'awaiting_payment'];
/** States between payment and the lane where a timeout may hand the order to self-rescue. */
export const RESCUABLE: readonly OrderStatus[] = ['paid', 'confirming', 'member_review', 'queued', 'revealing'];
/** Terminal states: no outgoing edges. */
export const TERMINAL: readonly OrderStatus[] = (Object.keys(TRANSITIONS) as OrderStatus[]).filter(
  (s) => TRANSITIONS[s].length === 0,
);

export class IllegalTransitionError extends Error {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`illegal order transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Returns `to` when the edge exists, throws IllegalTransitionError otherwise. */
export function transition(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}
