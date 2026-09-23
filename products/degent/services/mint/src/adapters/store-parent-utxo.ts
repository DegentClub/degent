/**
 * ParentUtxoProvider persisted in the OrderStore meta table. The lease is a single field, so at
 * most one reveal is ever being built on the parent at a time; the worker additionally runs
 * single-threaded (one tick at a time).
 */
import type { OrderStore } from '../ports/order-store.js';
import type { ParentUtxo, ParentUtxoProvider } from '../ports/parent-utxo.js';

interface State {
  utxo: (Omit<ParentUtxo, 'value'> & { value: string }) | null;
  leasedBy: string | null;
}

const KEY = 'parent_utxo';

export class StoreParentUtxoProvider implements ParentUtxoProvider {
  constructor(private readonly store: OrderStore) {}

  private async load(): Promise<State> {
    const raw = await this.store.getMeta(KEY);
    return raw ? (JSON.parse(raw) as State) : { utxo: null, leasedBy: null };
  }
  private async write(s: State): Promise<void> {
    await this.store.setMeta(KEY, JSON.stringify(s));
  }
  private static out(u: State['utxo']): ParentUtxo | null {
    return u ? { ...u, value: BigInt(u.value) } : null;
  }
  private static in(u: ParentUtxo): State['utxo'] {
    return { ...u, value: u.value.toString() };
  }

  /** Initialise (or replace, e.g. after a key rotation) the parent location. */
  async initialise(utxo: ParentUtxo, opts: { force?: boolean } = {}): Promise<void> {
    const s = await this.load();
    if (s.utxo && !opts.force) return;
    if (s.leasedBy && opts.force) throw new Error(`parent is leased by ${s.leasedBy}; drain before re-initialising`);
    await this.write({ utxo: StoreParentUtxoProvider.in(utxo), leasedBy: null });
  }

  async current(): Promise<ParentUtxo | null> {
    return StoreParentUtxoProvider.out((await this.load()).utxo);
  }

  async lease(orderId: string): Promise<ParentUtxo | null> {
    const s = await this.load();
    if (!s.utxo) return null;
    if (s.leasedBy && s.leasedBy !== orderId) return null;
    await this.write({ ...s, leasedBy: orderId });
    return StoreParentUtxoProvider.out(s.utxo);
  }

  async release(orderId: string): Promise<void> {
    const s = await this.load();
    if (s.leasedBy === orderId) await this.write({ ...s, leasedBy: null });
  }

  async advance(orderId: string, next: ParentUtxo): Promise<void> {
    const s = await this.load();
    if (s.leasedBy !== orderId) throw new Error(`parent not leased by ${orderId}`);
    await this.write({ utxo: StoreParentUtxoProvider.in(next), leasedBy: null });
  }

  async markConfirmed(txid: string): Promise<void> {
    const s = await this.load();
    if (s.utxo && s.utxo.txid === txid && !s.utxo.confirmed) await this.write({ ...s, utxo: { ...s.utxo, confirmed: true } });
  }

  async leasedBy(): Promise<string | null> {
    return (await this.load()).leasedBy;
  }
}
