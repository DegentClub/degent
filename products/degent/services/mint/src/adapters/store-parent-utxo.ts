/**
 * ParentUtxoProvider persisted in the OrderStore meta table. The lease is a single field, so at
 * most one reveal is ever being built on the parent at a time; the worker additionally runs
 * single-threaded (one tick at a time).
 *
 * Lease-change alerting (p5.2, RUNBOOK "Re-leasing or re-initialising the parent"):
 *   - every change of the parent LOCATION (initialise, force re-initialise, advance) logs the structured
 *     event `parent.lease.changed` with the old and new outpoint and value;
 *   - a change of the parent VALUE (old value != new value) additionally logs `parent.value.changed` at
 *     error level and persists an open alert. The worker does not co-sign while it is open (circuit
 *     breaker); only `acknowledgeValueChange` (admin endpoint `POST /v1/admin/parent/ack`) closes it.
 *     The alert lives in the same meta row as the parent, so it survives restarts.
 */
import type { Logger } from '../application/logger.js';
import { silentLogger } from '../application/logger.js';
import type { OrderStore } from '../ports/order-store.js';
import type {
  AcknowledgeResult,
  ParentLocation,
  ParentUtxo,
  ParentUtxoProvider,
  ParentValueAcknowledgement,
  ParentValueAlert,
} from '../ports/parent-utxo.js';

interface State {
  utxo: (Omit<ParentUtxo, 'value'> & { value: string }) | null;
  leasedBy: string | null;
  /** Open value alert (circuit breaker). Absent in rows written before p5.2 = closed. */
  alert?: ParentValueAlert | null;
  /** Last acknowledgement, kept for the audit trail in the row. */
  lastAck?: ParentValueAcknowledgement | null;
}

const KEY = 'parent_utxo';

export interface StoreParentUtxoOptions {
  log?: Logger;
  now?: () => Date;
}

const location = (u: { txid: string; vout: number; value: string | bigint }): ParentLocation => ({
  outpoint: `${u.txid}:${u.vout}`,
  valueSats: Number(u.value),
});

export class StoreParentUtxoProvider implements ParentUtxoProvider {
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(
    private readonly store: OrderStore,
    opts: StoreParentUtxoOptions = {},
  ) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
  }

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
  private static in(u: ParentUtxo): NonNullable<State['utxo']> {
    return { ...u, value: u.value.toString() };
  }

  /**
   * Move the parent from `s.utxo` to `next`, logging the change and opening the value alert when the value
   * differs. An already-open alert is kept (the first unacknowledged change is the one an operator must see).
   */
  private async relocate(s: State, next: ParentUtxo, reason: ParentValueAlert['reason'], leasedBy: string | null): Promise<void> {
    const prev = s.utxo;
    const to = StoreParentUtxoProvider.in(next);
    let alert = s.alert ?? null;
    const fields = {
      event: 'parent.lease.changed',
      reason,
      old: prev ? location(prev) : null,
      new: location(to),
    };
    if (prev && prev.value !== to.value && !alert) {
      alert = { at: this.now().toISOString(), reason, previous: location(prev), current: location(to) };
    } else if (alert) {
      // Keep the original change, but show where the parent is now.
      alert = { ...alert, current: location(to) };
    }
    await this.write({ ...s, utxo: to, leasedBy, alert });
    if (!prev || prev.txid !== to.txid || prev.vout !== to.vout || prev.value !== to.value) this.log.info('parent.lease.changed', fields);
    if (prev && prev.value !== to.value)
      this.log.error('parent.value.changed', {
        event: 'parent.value.changed',
        reason,
        old: location(prev),
        new: location(to),
        action: 'co-signing paused until an operator acknowledges: POST /v1/admin/parent/ack (RUNBOOK "Re-leasing or re-initialising the parent")',
      });
  }

  /** Initialise (or replace, e.g. after a key rotation) the parent location. */
  async initialise(utxo: ParentUtxo, opts: { force?: boolean } = {}): Promise<void> {
    const s = await this.load();
    if (s.utxo && !opts.force) return;
    if (s.leasedBy && opts.force) throw new Error(`parent is leased by ${s.leasedBy}; drain before re-initialising`);
    await this.relocate(s, utxo, 'initialise', null);
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
    await this.relocate(s, next, 'advance', null);
  }

  async markConfirmed(txid: string): Promise<void> {
    const s = await this.load();
    if (s.utxo && s.utxo.txid === txid && !s.utxo.confirmed) await this.write({ ...s, utxo: { ...s.utxo, confirmed: true } });
  }

  async leasedBy(): Promise<string | null> {
    return (await this.load()).leasedBy;
  }

  async valueAlert(): Promise<ParentValueAlert | null> {
    return (await this.load()).alert ?? null;
  }

  /** Last acknowledgement (audit trail; not part of the port). */
  async lastAcknowledgement(): Promise<ParentValueAcknowledgement | null> {
    return (await this.load()).lastAck ?? null;
  }

  async acknowledgeValueChange(ack: { outpoint: string; valueSats: number; by: string; at: Date; note?: string }): Promise<AcknowledgeResult> {
    const s = await this.load();
    if (!s.utxo) return { ok: false, reason: 'no_parent', parent: null };
    const parent = location(s.utxo);
    if (parent.outpoint !== ack.outpoint.toLowerCase() || parent.valueSats !== ack.valueSats) return { ok: false, reason: 'parent_mismatch', parent };
    const alert = s.alert ?? null;
    if (!alert) return { ok: true, acknowledged: null, parent };
    const acknowledged: ParentValueAcknowledgement = {
      alert,
      acknowledgedAt: ack.at.toISOString(),
      acknowledgedBy: ack.by,
      ...(ack.note ? { note: ack.note } : {}),
    };
    await this.write({ ...s, alert: null, lastAck: acknowledged });
    this.log.warn('parent.value.acknowledged', { event: 'parent.value.acknowledged', by: ack.by, parent, previous: alert.previous, note: ack.note });
    return { ok: true, acknowledged, parent };
  }
}
