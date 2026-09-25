/**
 * Edition reservations per artwork (plan §3.4, §3.7; ADR-0012). An artwork order reserves the next
 * edition number at quote time for the quote's TTL; the reservation is consumed when the order reaches
 * `paid` (it becomes `Order.edition`), released when the quote expires, and an expired number may be handed
 * to a later order. Numbers are 1-based and never shared between two consumed reservations. A consumed
 * reservation can also be force-released (`releaseHeld`, security review item 11) when the order that
 * consumed it never produces a confirmed reveal — see `OrderService.releaseEdition`.
 *
 * Edition caps (ADR-0012): `reserve` takes the artwork's `maxEditions` and refuses, inside the same
 * per-artwork critical section that picks the number, once active + consumed reservations reach it. That is
 * what keeps two concurrent quotes for the last edition from both succeeding.
 */
export interface EditionReservation {
  orderId: string;
  edition: number;
  expiresAt: string;
  consumed: boolean;
}

/** Thrown by `reserve` when the artwork's cap is reached (active + consumed reservations >= maxEditions). */
export class EditionsSoldOutError extends Error {
  constructor(
    readonly artworkId: string,
    readonly maxEditions: number,
    /** Active (unexpired) plus consumed reservations when the reservation was refused. */
    readonly held: number,
  ) {
    super(`artwork ${artworkId} is sold out (${held} of ${maxEditions} editions minted or reserved)`);
    this.name = 'EditionsSoldOutError';
  }
}

export interface ReserveOptions {
  /** The artwork's edition cap; null / absent = open edition. */
  maxEditions?: number | null;
}

export interface EditionStore {
  /**
   * Reserve the lowest edition not held by an active (unexpired) or consumed reservation. Idempotent per
   * order: a second call for the same order returns its existing number (refreshing the expiry), even at the
   * cap. A NEW reservation throws EditionsSoldOutError when active + consumed >= `opts.maxEditions`.
   */
  reserve(artworkId: string, orderId: string, expiresAt: Date, now: Date, opts?: ReserveOptions): Promise<number>;
  /**
   * Turn the order's reservation into its edition. Idempotent. `edition` is the number the order was quoted
   * (and signed into its reveal): when the reservation was released after expiry, the number is re-claimed
   * if nobody else holds it. Returns null when another order holds or consumed that number (the reveal was
   * signed with a number that is no longer this order's).
   */
  consume(artworkId: string, orderId: string, edition: number, now: Date): Promise<number | null>;
  /** Drop an unconsumed reservation (quote expired). No-op otherwise. */
  release(artworkId: string, orderId: string): Promise<void>;
  /**
   * Force-drop the order's reservation whether it is still active or already consumed (security review item
   * 11: a griefing 0-conf funding tx that never confirms must not burn the edition forever). No-op when the
   * order holds no reservation. Idempotent and safe under the artwork's per-artwork lock; the freed number can
   * be reserved by a later order. Callers must never call this once a real inscription exists for the order
   * (see `hasConfirmedReveal` in `domain/order.ts`) — this store has no way to check that itself.
   */
  releaseHeld(artworkId: string, orderId: string): Promise<void>;
  reservation(artworkId: string, orderId: string): Promise<EditionReservation | null>;
  /** Editions consumed so far for the artwork (the studio's "editions minted"). */
  consumedCount(artworkId: string): Promise<number>;
  /** Consumed plus unexpired reservations at `now`: what counts against `maxEditions`. */
  countActive(artworkId: string, now: Date): Promise<number>;
}
