import type { OrderStatus } from '@bsh/degent-mint-sdk';
import type { OrderRecord } from '../domain/order.js';

/**
 * Persistence for orders. Writes are optimistic: callers pass the record they read; the store
 * checks the stored version equals `record.version`, persists it as `version + 1` and returns the
 * saved record. A mismatch throws StaleWriteError, so the API and the worker never clobber each
 * other's transitions.
 */
export interface OrderStore {
  create(record: OrderRecord): Promise<void>;
  get(id: string): Promise<OrderRecord | null>;
  save(record: OrderRecord): Promise<OrderRecord>;
  listByStatus(statuses: readonly OrderStatus[]): Promise<OrderRecord[]>;
  /** Small key/value area for service state (e.g. the parent UTXO chain tip). */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  close?(): void;
}
