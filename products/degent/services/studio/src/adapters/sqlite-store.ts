/**
 * node:sqlite store (Node >= 22.5) implementing every persistence port of the studio: artists,
 * artworks, royalties and SIWB nonces. One row per record with the record as JSON plus indexed
 * columns; WAL mode; optimistic concurrency via `WHERE version = ?` (same pattern as the mint).
 */
import { DatabaseSync } from 'node:sqlite';
import type { NonceConsumeResult, NonceRecord, NonceStore } from '@bsh/identity';
import type { ArtistRecord, ArtworkCounts } from '../domain/artist.js';
import type { ArtworkRecord } from '../domain/artwork.js';
import { StaleWriteError } from '../domain/errors.js';
import type { RoyaltyRecord } from '../domain/royalty.js';
import type { ArtistStore } from '../ports/artist-store.js';
import type { ArtworkPage, ArtworkQuery, ArtworkStore } from '../ports/artwork-store.js';
import type { RoyaltyPage, RoyaltyStore } from '../ports/royalty-store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artists (
  address     TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  joined_at   TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artworks (
  id          TEXT PRIMARY KEY,
  artist      TEXT NOT NULL,
  status      TEXT NOT NULL,
  featured    INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artworks_gallery ON artworks(status, featured, created_at);
CREATE INDEX IF NOT EXISTS artworks_artist ON artworks(artist, status);
CREATE TABLE IF NOT EXISTS royalties (
  order_id     TEXT PRIMARY KEY,
  artist       TEXT NOT NULL,
  royalty_sats INTEGER NOT NULL,
  at           TEXT NOT NULL,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS royalties_artist ON royalties(artist, at);
CREATE TABLE IF NOT EXISTS nonces (
  nonce       TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,
  address     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
`;

export class SqliteStudioStore {
  private readonly db: DatabaseSync;
  /** Port views sharing one connection. */
  readonly artists: ArtistStore;
  readonly artworks: ArtworkStore;
  readonly royalties: RoyaltyStore;
  readonly nonces: NonceStore;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.artists = { create: (r) => this.createArtist(r), get: (a) => this.getArtist(a), save: (r) => this.saveArtist(r) };
    this.artworks = {
      create: (r) => this.createArtwork(r),
      get: (id) => this.getArtwork(id),
      save: (r) => this.saveArtwork(r),
      list: (q) => this.list(q),
      countByArtist: (a) => this.countByArtist(a),
    };
    this.royalties = { create: (r) => this.createRoyalty(r), getByOrder: (o) => this.getByOrder(o), listByArtist: (a, p, s) => this.listByArtist(a, p, s) };
    this.nonces = { issue: (r) => this.issue(r), consume: (n, b, now) => this.consume(n, b, now) };
  }

  // ------------------------------------------------------------------ artists

  async createArtist(r: ArtistRecord): Promise<void> {
    this.db.prepare('INSERT INTO artists (address, version, joined_at, data) VALUES (?, ?, ?, ?)').run(r.address, r.version, r.joinedAt, JSON.stringify(r));
  }

  async getArtist(address: string): Promise<ArtistRecord | null> {
    const row = this.db.prepare('SELECT data FROM artists WHERE address = ?').get(address) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ArtistRecord) : null;
  }

  async saveArtist(r: ArtistRecord): Promise<ArtistRecord> {
    const next: ArtistRecord = { ...r, version: r.version + 1 };
    const res = this.db.prepare('UPDATE artists SET version = ?, data = ? WHERE address = ? AND version = ?').run(next.version, JSON.stringify(next), r.address, r.version);
    if (Number(res.changes) !== 1) throw new StaleWriteError(r.address, r.version);
    return next;
  }

  // ------------------------------------------------------------------ artworks

  async createArtwork(r: ArtworkRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO artworks (id, artist, status, featured, version, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.artist, r.status, r.featured ? 1 : 0, r.version, r.createdAt, JSON.stringify(r));
  }

  async getArtwork(id: string): Promise<ArtworkRecord | null> {
    const row = this.db.prepare('SELECT data FROM artworks WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ArtworkRecord) : null;
  }

  async saveArtwork(r: ArtworkRecord): Promise<ArtworkRecord> {
    const next: ArtworkRecord = { ...r, version: r.version + 1 };
    const res = this.db
      .prepare('UPDATE artworks SET artist = ?, status = ?, featured = ?, version = ?, data = ? WHERE id = ? AND version = ?')
      .run(next.artist, next.status, next.featured ? 1 : 0, next.version, JSON.stringify(next), r.id, r.version);
    if (Number(res.changes) !== 1) throw new StaleWriteError(r.id, r.version);
    return next;
  }

  async list(q: ArtworkQuery): Promise<ArtworkPage> {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status !== undefined) {
      where.push('status = ?');
      args.push(q.status);
    }
    if (q.artist !== undefined) {
      where.push('artist = ?');
      args.push(q.artist);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM artworks ${w}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT data FROM artworks ${w} ORDER BY featured DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, q.pageSize, (q.page - 1) * q.pageSize) as Array<{ data: string }>;
    return { items: rows.map((r) => JSON.parse(r.data) as ArtworkRecord), total: Number(total) };
  }

  async countByArtist(address: string): Promise<ArtworkCounts> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved FROM artworks WHERE artist = ?")
      .get(address) as { total: number; approved: number | null };
    return { total: Number(row.total), approved: Number(row.approved ?? 0) };
  }

  // ------------------------------------------------------------------ royalties

  async createRoyalty(r: RoyaltyRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO royalties (order_id, artist, royalty_sats, at, data) VALUES (?, ?, ?, ?, ?)')
      .run(r.orderId, r.artist, r.royaltySats, r.at, JSON.stringify(r));
  }

  async getByOrder(orderId: string): Promise<RoyaltyRecord | null> {
    const row = this.db.prepare('SELECT data FROM royalties WHERE order_id = ?').get(orderId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as RoyaltyRecord) : null;
  }

  async listByArtist(address: string, page: number, pageSize: number): Promise<RoyaltyPage> {
    const t = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(royalty_sats), 0) AS sats FROM royalties WHERE artist = ?').get(address) as { n: number; sats: number };
    const rows = this.db
      .prepare('SELECT data FROM royalties WHERE artist = ? ORDER BY at DESC, order_id DESC LIMIT ? OFFSET ?')
      .all(address, pageSize, (page - 1) * pageSize) as Array<{ data: string }>;
    return { items: rows.map((r) => JSON.parse(r.data) as RoyaltyRecord), total: Number(t.n), totals: { records: Number(t.n), royaltySats: Number(t.sats) } };
  }

  // ------------------------------------------------------------------ nonces (@bsh/identity NonceStore)

  async issue(r: NonceRecord): Promise<void> {
    this.db.prepare('INSERT INTO nonces (nonce, domain, address, expires_at, used) VALUES (?, ?, ?, ?, 0)').run(r.nonce, r.domain, r.address, r.expiresAt);
  }

  async consume(nonce: string, binding: { domain: string; address: string }, now: number): Promise<NonceConsumeResult> {
    const row = this.db.prepare('SELECT domain, address, expires_at, used FROM nonces WHERE nonce = ?').get(nonce) as
      | { domain: string; address: string; expires_at: number; used: number }
      | undefined;
    if (!row) return 'unknown';
    if (row.used) return 'replayed';
    if (row.domain !== binding.domain || row.address !== binding.address) return 'unknown';
    if (now >= Number(row.expires_at)) return 'expired';
    // Atomic check-and-set: only the first UPDATE flips used.
    const res = this.db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ? AND used = 0').run(nonce);
    return Number(res.changes) === 1 ? 'ok' : 'replayed';
  }

  /** Drop nonces that can no longer be consumed (call periodically). */
  sweepNonces(now: number, retainMs = 60_000): number {
    return Number(this.db.prepare('DELETE FROM nonces WHERE expires_at + ? <= ?').run(retainMs, now).changes);
  }

  close(): void {
    this.db.close();
  }
}
