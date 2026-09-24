import type { ListingStatus } from '@bsh/degent-market-sdk';
import type { BuySession, ListingRecord } from '../domain/listing.js';

export interface ListingStore {
  get(inscriptionId: string): Promise<ListingRecord | null>;
  /** Insert a new listing; replaces a closed row for the same inscription, throws if an open one exists. */
  insert(r: ListingRecord): Promise<void>;
  /** Optimistic write: succeeds only if the stored version equals `r.version`; returns the stored record (version + 1). */
  save(r: ListingRecord): Promise<ListingRecord>;
  listByStatus(statuses: readonly ListingStatus[]): Promise<ListingRecord[]>;
}

export interface BuySessionStore {
  createSession(s: BuySession): Promise<void>;
  getSession(id: string): Promise<BuySession | null>;
  /** Atomically move `open` → `broadcasting`. False when the session was not open. */
  claimSession(id: string): Promise<boolean>;
  /** `broadcasting` → `broadcast` (with txid) or back to `open` after a failed broadcast. */
  finishSession(id: string, outcome: { txid: string } | 'released'): Promise<void>;
  /** Drop open sessions that expired before `nowIso`. */
  purgeSessions(nowIso: string): Promise<number>;
}
