import type { OrderStatus } from '@bsh/degent-mint-sdk';
import type { OrderRecord } from '../domain/order.js';
import { StaleWriteError } from '../domain/errors.js';
import type { OrderStore } from '../ports/order-store.js';

/** In-memory OrderStore (dev, tests). Records are deep-copied in and out. */
export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly meta = new Map<string, string>();

  async create(record: OrderRecord): Promise<void> {
    if (this.orders.has(record.id)) throw new Error(`order ${record.id} already exists`);
    this.orders.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<OrderRecord | null> {
    const r = this.orders.get(id);
    return r ? structuredClone(r) : null;
  }

  async save(record: OrderRecord): Promise<OrderRecord> {
    const cur = this.orders.get(record.id);
    if (!cur || cur.version !== record.version) throw new StaleWriteError(record.id, record.version);
    const next = structuredClone({ ...record, version: record.version + 1 });
    this.orders.set(record.id, next);
    return structuredClone(next);
  }

  async listByStatus(statuses: readonly OrderStatus[]): Promise<OrderRecord[]> {
    return [...this.orders.values()]
      .filter((o) => statuses.includes(o.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((o) => structuredClone(o));
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  async incrementMeta(key: string): Promise<number> {
    const next = Number(this.meta.get(key) ?? '0') + 1;
    this.meta.set(key, String(next));
    return next;
  }
}
