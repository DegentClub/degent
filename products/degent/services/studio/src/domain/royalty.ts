/**
 * A royalty record: one mint order that paid the artist. Fed by the mint service through
 * POST /v1/internal/royalties (ADR-0007 §5: royalty = output [1] of the minter's funding PSBT).
 */
export interface RoyaltyRecord {
  /** The mint order id: idempotency key. */
  orderId: string;
  artworkId: string;
  /** Artist address (owner of the artwork at the time of the mint). */
  artist: string;
  minterAddress: string | null;
  royaltySats: number;
  fundingTxid: string;
  vout: number;
  /** When the funding transaction was seen. */
  at: string;
  recordedAt: string;
}

export interface RoyaltyTotals {
  records: number;
  royaltySats: number;
}

/** The facts that must agree for a replayed record to count as the same one. */
export function sameRoyaltyFacts(a: RoyaltyRecord, b: RoyaltyRecord): boolean {
  return a.artworkId === b.artworkId && a.royaltySats === b.royaltySats && a.fundingTxid === b.fundingTxid && a.vout === b.vout;
}
