import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_STORED_ORDERS,
  ORDERS_STORAGE_KEY,
  clearOrders,
  isOrdinalsInscriptionId,
  latestOrder,
  loadOrders,
  removeOrder,
  saveOrder,
  updateOrder,
  type StoredOrder,
  type StorageLike,
} from '@/lib/orders';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function order(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    inscriptionId: 'insc-1',
    paymentAddress: 'bc1qpay',
    txid: 'tx-1',
    amountSats: 10_000,
    feeRate: 2,
    fileHash: 'hash',
    fileName: 'a.png',
    recipient: 'bc1precipient',
    createdAt: 1000,
    status: 'paid',
    ...overrides,
  };
}

describe('orders persistence', () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it('round-trips through storage', () => {
    saveOrder(order(), storage);
    expect(loadOrders(storage)).toEqual([order()]);
    expect(latestOrder(storage)).toEqual(order());
  });

  it('sorts newest first and replaces by txid', () => {
    saveOrder(order({ txid: 'old', createdAt: 1 }), storage);
    saveOrder(order({ txid: 'new', createdAt: 2 }), storage);
    saveOrder(order({ txid: 'old', createdAt: 1, amountSats: 5 }), storage);
    const orders = loadOrders(storage);
    expect(orders.map((o) => o.txid)).toEqual(['new', 'old']);
    expect(orders[1].amountSats).toBe(5);
  });

  it('updates a single order and reports null for unknown txids', () => {
    saveOrder(order(), storage);
    const updated = updateOrder('tx-1', { status: 'confirmed', confirmedHeight: 850_000 }, storage);
    expect(updated?.status).toBe('confirmed');
    expect(loadOrders(storage)[0].confirmedHeight).toBe(850_000);
    expect(updateOrder('missing', { status: 'confirmed' }, storage)).toBeNull();
  });

  it('removes and clears', () => {
    saveOrder(order({ txid: 'a' }), storage);
    saveOrder(order({ txid: 'b' }), storage);
    expect(removeOrder('a', storage).map((o) => o.txid)).toEqual(['b']);
    clearOrders(storage);
    expect(loadOrders(storage)).toEqual([]);
    expect(latestOrder(storage)).toBeNull();
  });

  it('caps the history length', () => {
    for (let i = 0; i < MAX_STORED_ORDERS + 10; i++) saveOrder(order({ txid: `tx-${i}`, createdAt: i }), storage);
    expect(loadOrders(storage)).toHaveLength(MAX_STORED_ORDERS);
    expect(loadOrders(storage)[0].txid).toBe(`tx-${MAX_STORED_ORDERS + 9}`);
  });

  it('ignores corrupt or foreign data instead of throwing', () => {
    storage.setItem(ORDERS_STORAGE_KEY, '{not json');
    expect(loadOrders(storage)).toEqual([]);
    storage.setItem(ORDERS_STORAGE_KEY, JSON.stringify([{ txid: 'x' }, order(), 42]));
    expect(loadOrders(storage)).toEqual([order()]);
  });

  it('survives a missing storage (SSR / privacy mode)', () => {
    expect(loadOrders(null)).toEqual([]);
    expect(saveOrder(order(), null)).toEqual([order()]);
    expect(() => clearOrders(null)).not.toThrow();
  });

  it('uses window.localStorage by default in the browser', () => {
    window.localStorage.clear();
    saveOrder(order());
    expect(JSON.parse(window.localStorage.getItem(ORDERS_STORAGE_KEY) ?? '[]')).toHaveLength(1);
    clearOrders();
    expect(window.localStorage.getItem(ORDERS_STORAGE_KEY)).toBeNull();
  });
});

describe('isOrdinalsInscriptionId', () => {
  it('matches <txid>i<n> only', () => {
    expect(isOrdinalsInscriptionId(`${'a'.repeat(64)}i0`)).toBe(true);
    expect(isOrdinalsInscriptionId(`${'0'.repeat(64)}i12`)).toBe(true);
    expect(isOrdinalsInscriptionId('insc-1')).toBe(false);
    expect(isOrdinalsInscriptionId(`${'a'.repeat(63)}i0`)).toBe(false);
    expect(isOrdinalsInscriptionId(`${'A'.repeat(64)}i0`)).toBe(false);
  });
});
