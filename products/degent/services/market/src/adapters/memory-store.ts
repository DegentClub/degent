/** In-memory ListingStore + BuySessionStore (tests, regtest dev). Same semantics as the sqlite adapter. */
import { OPEN_LISTING_STATUSES, type ListingStatus } from '@bsh/degent-market-sdk';
import { StaleWriteError } from '../domain/errors.js';
import type { BuySession, ListingRecord } from '../domain/listing.js';
import type { BuySessionStore, ListingStore } from '../ports/listing-store.js';

export class MemoryMarketStore implements ListingStore, BuySessionStore {
  private readonly listings = new Map<string, ListingRecord>();
  private readonly sessions = new Map<string, BuySession>();

  async get(id: string): Promise<ListingRecord | null> {
    const r = this.listings.get(id);
    return r ? structuredClone(r) : null;
  }

  async insert(r: ListingRecord): Promise<void> {
    const existing = this.listings.get(r.inscriptionId);
    if (existing && OPEN_LISTING_STATUSES.includes(existing.status)) throw new Error(`open listing for ${r.inscriptionId} exists`);
    this.listings.set(r.inscriptionId, structuredClone(r));
  }

  async save(r: ListingRecord): Promise<ListingRecord> {
    const cur = this.listings.get(r.inscriptionId);
    if (!cur || cur.version !== r.version || cur.createdAt !== r.createdAt) throw new StaleWriteError(r.inscriptionId, r.version);
    const next = { ...structuredClone(r), version: r.version + 1 };
    this.listings.set(r.inscriptionId, next);
    return structuredClone(next);
  }

  async listByStatus(statuses: readonly ListingStatus[]): Promise<ListingRecord[]> {
    return [...this.listings.values()].filter((r) => statuses.includes(r.status)).map((r) => structuredClone(r));
  }

  async createSession(s: BuySession): Promise<void> {
    if (this.sessions.has(s.id)) throw new Error('session exists');
    this.sessions.set(s.id, structuredClone(s));
  }

  async getSession(id: string): Promise<BuySession | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async claimSession(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'open') return false;
    s.status = 'broadcasting';
    return true;
  }

  async finishSession(id: string, outcome: { txid: string } | 'released'): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'broadcasting') return;
    if (outcome === 'released') s.status = 'open';
    else {
      s.status = 'broadcast';
      s.txid = outcome.txid;
    }
  }

  async purgeSessions(nowIso: string): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) if (s.status === 'open' && s.expiresAt < nowIso) (this.sessions.delete(id), n++);
    return n;
  }
}
