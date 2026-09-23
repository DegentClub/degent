/**
 * node:sqlite OrderStore (Node >= 22.5). One row per order with the record as JSON plus indexed
 * columns for status and version; WAL mode; optimistic concurrency via `WHERE version = ?`.
 */
import { DatabaseSync } from 'node:sqlite';
import type { OrderStatus } from '@bsh/degent-mint-sdk';
import type { OrderRecord } from '../domain/order.js';
import { StaleWriteError } from '../domain/errors.js';
import type { OrderStore } from '../ports/order-store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  lane        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class SqliteOrderStore implements OrderStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  async create(r: OrderRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO orders (id, status, lane, version, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.status, r.lane, r.version, r.createdAt, r.updatedAt, JSON.stringify(r));
  }

  async get(id: string): Promise<OrderRecord | null> {
    const row = this.db.prepare('SELECT data FROM orders WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OrderRecord) : null;
  }

  async save(r: OrderRecord): Promise<OrderRecord> {
    const next: OrderRecord = { ...r, version: r.version + 1 };
    const res = this.db
      .prepare('UPDATE orders SET status = ?, lane = ?, version = ?, updated_at = ?, data = ? WHERE id = ? AND version = ?')
      .run(next.status, next.lane, next.version, next.updatedAt, JSON.stringify(next), r.id, r.version);
    if (Number(res.changes) !== 1) throw new StaleWriteError(r.id, r.version);
    return next;
  }

  async listByStatus(statuses: readonly OrderStatus[]): Promise<OrderRecord[]> {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT data FROM orders WHERE status IN (${marks}) ORDER BY created_at, id`)
      .all(...statuses) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as OrderRecord);
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
