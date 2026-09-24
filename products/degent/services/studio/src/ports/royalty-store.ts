import type { RoyaltyRecord, RoyaltyTotals } from '../domain/royalty.js';

export interface RoyaltyPage {
  items: RoyaltyRecord[];
  total: number;
  /** Totals over ALL the artist's records, not just this page. */
  totals: RoyaltyTotals;
}

/** Append-only royalty ledger keyed by mint order id. */
export interface RoyaltyStore {
  /** Throws when `orderId` already exists. */
  create(record: RoyaltyRecord): Promise<void>;
  getByOrder(orderId: string): Promise<RoyaltyRecord | null>;
  /** Newest first (at desc, orderId desc). */
  listByArtist(address: string, page: number, pageSize: number): Promise<RoyaltyPage>;
}
