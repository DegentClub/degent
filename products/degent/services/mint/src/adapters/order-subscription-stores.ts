import type { DatabaseSync } from 'node:sqlite';
import type { OrderSubscriptionRecord, OrderSubscriptionStore } from '../ports/order-subscription-store.js';

/** In-memory OrderSubscriptionStore (dev, tests). */
export class MemoryOrderSubscriptionStore implements OrderSubscriptionStore {
  private readonly subs = new Map<string, OrderSubscriptionRecord>();

  async add(sub: OrderSubscriptionRecord): Promise<OrderSubscriptionRecord> {
    const existing = this.subs.get(sub.id);
    if (existing) return structuredClone(existing);
    this.subs.set(sub.id, structuredClone(sub));
    return structuredClone(sub);
  }

  async listByOrder(orderId: string): Promise<OrderSubscriptionRecord[]> {
    return [...this.subs.values()].filter((s) => s.orderId === orderId).map((s) => structuredClone(s));
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS order_subscriptions (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL,
  channel    TEXT NOT NULL,
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_subscriptions_order ON order_subscriptions(order_id);
`;

type Row = { id: string; order_id: string; channel: string; address: string; created_at: string };
const fromRow = (r: Row): OrderSubscriptionRecord => ({
  id: r.id,
  orderId: r.order_id,
  channel: r.channel as OrderSubscriptionRecord['channel'],
  address: r.address,
  createdAt: r.created_at,
});

/** node:sqlite OrderSubscriptionStore sharing the order store's database. */
export class SqliteOrderSubscriptionStore implements OrderSubscriptionStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  async add(s: OrderSubscriptionRecord): Promise<OrderSubscriptionRecord> {
    this.db
      .prepare('INSERT OR IGNORE INTO order_subscriptions (id, order_id, channel, address, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(s.id, s.orderId, s.channel, s.address, s.createdAt);
    const row = this.db.prepare('SELECT * FROM order_subscriptions WHERE id = ?').get(s.id) as Row;
    return fromRow(row);
  }

  async listByOrder(orderId: string): Promise<OrderSubscriptionRecord[]> {
    const rows = this.db.prepare('SELECT * FROM order_subscriptions WHERE order_id = ? ORDER BY created_at, id').all(orderId) as Row[];
    return rows.map(fromRow);
  }
}
