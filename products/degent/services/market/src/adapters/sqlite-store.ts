/**
 * node:sqlite adapters (Node >= 22.5): listings (record as JSON + indexed status/version columns,
 * optimistic concurrency via `WHERE version = ?`), buy sessions (atomic claim), and the SIWB nonce
 * store (`@bsh/identity` NonceStore: atomic single-use consume). One database file, WAL mode.
 */
import { DatabaseSync } from 'node:sqlite';
import type { NonceConsumeResult, NonceRecord, NonceStore } from '@bsh/identity';
import type { ListingStatus } from '@bsh/degent-market-sdk';
import { StaleWriteError } from '../domain/errors.js';
import type { BuySession, ListingRecord } from '../domain/listing.js';
import type { BuySessionStore, ListingStore } from '../ports/listing-store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  inscription_id TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  version        INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  data           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_status ON listings(status, created_at);
CREATE TABLE IF NOT EXISTS buy_sessions (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS siwb_nonces (
  nonce      TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  address    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
`;

export class SqliteMarketStore implements ListingStore, BuySessionStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  async get(id: string): Promise<ListingRecord | null> {
    const row = this.db.prepare('SELECT data FROM listings WHERE inscription_id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ListingRecord) : null;
  }

  async insert(r: ListingRecord): Promise<void> {
    const res = this.db
      .prepare(
        `INSERT INTO listings (inscription_id, status, version, created_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(inscription_id) DO UPDATE SET status = excluded.status, version = excluded.version, created_at = excluded.created_at, data = excluded.data
         WHERE listings.status NOT IN ('active', 'pending')`,
      )
      .run(r.inscriptionId, r.status, r.version, r.createdAt, JSON.stringify(r));
    if (Number(res.changes) !== 1) throw new Error(`open listing for ${r.inscriptionId} exists`);
  }

  async save(r: ListingRecord): Promise<ListingRecord> {
    const next: ListingRecord = { ...r, version: r.version + 1 };
    const res = this.db
      .prepare('UPDATE listings SET status = ?, version = ?, data = ? WHERE inscription_id = ? AND version = ? AND created_at = ?')
      .run(next.status, next.version, JSON.stringify(next), r.inscriptionId, r.version, r.createdAt);
    if (Number(res.changes) !== 1) throw new StaleWriteError(r.inscriptionId, r.version);
    return next;
  }

  async listByStatus(statuses: readonly ListingStatus[]): Promise<ListingRecord[]> {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT data FROM listings WHERE status IN (${marks}) ORDER BY created_at, inscription_id`).all(...statuses) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as ListingRecord);
  }

  async createSession(s: BuySession): Promise<void> {
    this.db.prepare('INSERT INTO buy_sessions (id, status, expires_at, data) VALUES (?, ?, ?, ?)').run(s.id, s.status, s.expiresAt, JSON.stringify(s));
  }

  async getSession(id: string): Promise<BuySession | null> {
    const row = this.db.prepare('SELECT status, data FROM buy_sessions WHERE id = ?').get(id) as { status: string; data: string } | undefined;
    if (!row) return null;
    return { ...(JSON.parse(row.data) as BuySession), status: row.status as BuySession['status'] };
  }

  async claimSession(id: string): Promise<boolean> {
    const res = this.db.prepare("UPDATE buy_sessions SET status = 'broadcasting' WHERE id = ? AND status = 'open'").run(id);
    return Number(res.changes) === 1;
  }

  async finishSession(id: string, outcome: { txid: string } | 'released'): Promise<void> {
    if (outcome === 'released') {
      this.db.prepare("UPDATE buy_sessions SET status = 'open' WHERE id = ? AND status = 'broadcasting'").run(id);
      return;
    }
    const s = await this.getSession(id);
    if (!s) return;
    this.db
      .prepare("UPDATE buy_sessions SET status = 'broadcast', data = ? WHERE id = ? AND status = 'broadcasting'")
      .run(JSON.stringify({ ...s, status: 'broadcast', txid: outcome.txid }), id);
  }

  async purgeSessions(nowIso: string): Promise<number> {
    const res = this.db.prepare("DELETE FROM buy_sessions WHERE status = 'open' AND expires_at < ?").run(nowIso);
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }
}

/** `@bsh/identity` NonceStore on the same database: `consume` is one atomic UPDATE. */
export class SqliteNonceStore implements NonceStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  async issue(r: NonceRecord): Promise<void> {
    this.db.prepare('INSERT INTO siwb_nonces (nonce, domain, address, expires_at) VALUES (?, ?, ?, ?)').run(r.nonce, r.domain, r.address, r.expiresAt);
  }

  async consume(nonce: string, binding: { domain: string; address: string }, now: number): Promise<NonceConsumeResult> {
    const res = this.db
      .prepare('UPDATE siwb_nonces SET used = 1 WHERE nonce = ? AND used = 0 AND domain = ? AND address = ? AND expires_at > ?')
      .run(nonce, binding.domain, binding.address, now);
    if (Number(res.changes) === 1) return 'ok';
    const row = this.db.prepare('SELECT domain, address, expires_at, used FROM siwb_nonces WHERE nonce = ?').get(nonce) as
      | { domain: string; address: string; expires_at: number; used: number }
      | undefined;
    if (!row || row.domain !== binding.domain || row.address !== binding.address) return 'unknown';
    if (row.used) return 'replayed';
    return 'expired';
  }

  /** Drop nonces that can no longer be consumed. */
  sweep(now: number): number {
    return Number(this.db.prepare('DELETE FROM siwb_nonces WHERE expires_at <= ?').run(now - 60_000).changes);
  }
}
