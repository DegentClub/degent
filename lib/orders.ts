/**
 * Client-side order persistence (localStorage).
 *
 * The app has no database: once the wallet broadcasts the payment, the only
 * record the user has is the txid and the Skrybit inscription id. We keep
 * those in the browser so a refresh does not lose the tracking view.
 */

export type OrderStatus = 'paid' | 'confirmed' | 'inscribed';

export interface StoredOrder {
  /** Skrybit-side identifier returned by create-commit. */
  inscriptionId: string;
  paymentAddress: string;
  txid: string;
  amountSats: number;
  feeRate: number;
  fileHash: string;
  fileName: string;
  recipient: string;
  createdAt: number;
  status: OrderStatus;
  /** Block height of the payment tx once confirmed. */
  confirmedHeight?: number;
  /** Set when the user clicked "Mint another"; the order stays in history but is no longer shown. */
  dismissed?: boolean;
}

export const ORDERS_STORAGE_KEY = 'degen-minter:orders:v1';
export const MAX_STORED_ORDERS = 25;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStoredOrder(value: unknown): value is StoredOrder {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.inscriptionId === 'string' &&
    typeof o.txid === 'string' &&
    typeof o.paymentAddress === 'string' &&
    typeof o.createdAt === 'number' &&
    (o.status === 'paid' || o.status === 'confirmed' || o.status === 'inscribed')
  );
}

export function loadOrders(storage: StorageLike | null = defaultStorage()): StoredOrder[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(ORDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredOrder).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function persist(orders: StoredOrder[], storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(orders.slice(0, MAX_STORED_ORDERS)));
  } catch {
    // Quota or privacy mode: the in-memory state still works for this session.
  }
}

/** Insert or replace (by txid) an order, newest first. */
export function saveOrder(order: StoredOrder, storage: StorageLike | null = defaultStorage()): StoredOrder[] {
  const others = loadOrders(storage).filter((o) => o.txid !== order.txid);
  const next = [order, ...others].sort((a, b) => b.createdAt - a.createdAt);
  persist(next, storage);
  return next;
}

export function updateOrder(
  txid: string,
  patch: Partial<Omit<StoredOrder, 'txid'>>,
  storage: StorageLike | null = defaultStorage()
): StoredOrder | null {
  const orders = loadOrders(storage);
  const index = orders.findIndex((o) => o.txid === txid);
  if (index === -1) return null;
  const updated = { ...orders[index], ...patch, txid };
  orders[index] = updated;
  persist(orders, storage);
  return updated;
}

export function removeOrder(txid: string, storage: StorageLike | null = defaultStorage()): StoredOrder[] {
  const next = loadOrders(storage).filter((o) => o.txid !== txid);
  persist(next, storage);
  return next;
}

export function latestOrder(storage: StorageLike | null = defaultStorage()): StoredOrder | null {
  return loadOrders(storage)[0] ?? null;
}

export function clearOrders(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(ORDERS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** ordinals.com only understands real inscription ids (<txid>i<index>). */
export function isOrdinalsInscriptionId(id: string): boolean {
  return /^[0-9a-f]{64}i\d+$/.test(id);
}
