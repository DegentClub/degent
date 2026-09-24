/**
 * Edition reservations per artwork (plan §3.4, §3.7; ADR-0010 to come). An artwork order reserves the next
 * edition number at quote time for the quote's TTL; the reservation is consumed when the order reaches
 * `paid` (it becomes `Order.edition`), released when the quote expires, and an expired number may be handed
 * to a later order. Numbers are 1-based and never shared between two consumed reservations.
 */
export interface EditionReservation {
  orderId: string;
  edition: number;
  expiresAt: string;
  consumed: boolean;
}

export interface EditionStore {
  /**
   * Reserve the lowest edition not held by an active (unexpired) or consumed reservation. Idempotent per
   * order: a second call for the same order returns its existing number (refreshing the expiry).
   */
  reserve(artworkId: string, orderId: string, expiresAt: Date, now: Date): Promise<number>;
  /**
   * Turn the order's reservation into its edition. Idempotent. `edition` is the number the order was quoted
   * (and signed into its reveal): when the reservation was released after expiry, the number is re-claimed
   * if nobody else holds it. Returns null when another order holds or consumed that number (the reveal was
   * signed with a number that is no longer this order's).
   */
  consume(artworkId: string, orderId: string, edition: number, now: Date): Promise<number | null>;
  /** Drop an unconsumed reservation (quote expired). No-op otherwise. */
  release(artworkId: string, orderId: string): Promise<void>;
  reservation(artworkId: string, orderId: string): Promise<EditionReservation | null>;
  /** Editions consumed so far for the artwork (the studio's "editions minted"). */
  consumedCount(artworkId: string): Promise<number>;
}
