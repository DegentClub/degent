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
  /** The edition number the mint assigned (ADR-0012); absent when the mint did not say. */
  edition?: number;
}

export interface RoyaltyTotals {
  records: number;
  royaltySats: number;
}

/**
 * The facts that must agree for a replayed record to count as the same one. The edition only counts when
 * both carry it (a replay from a mint that did not send it yet is the same record).
 */
export function sameRoyaltyFacts(a: RoyaltyRecord, b: RoyaltyRecord): boolean {
  const sameEdition = a.edition === undefined || b.edition === undefined || a.edition === b.edition;
  return a.artworkId === b.artworkId && a.royaltySats === b.royaltySats && a.fundingTxid === b.fundingTxid && a.vout === b.vout && sameEdition;
}
