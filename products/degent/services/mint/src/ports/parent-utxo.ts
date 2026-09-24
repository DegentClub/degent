import type { Lane } from '@bsh/degent-mint-sdk';

export interface ParentUtxo {
  txid: string;
  vout: number;
  value: bigint;
  scriptHex: string;
  /** False while the tx that created it is unconfirmed. */
  confirmed: boolean;
  /** Lane of the reveal that created this UTXO (null for the initial/external one). */
  createdByLane: Lane | null;
}

/** One side of a parent location change, as logged and as returned by the admin API. */
export interface ParentLocation {
  /** `<txid>:<vout>` */
  outpoint: string;
  valueSats: number;
}

/**
 * Open circuit breaker (RUNBOOK "Re-leasing or re-initialising the parent"): the parent's VALUE changed
 * (not just its outpoint). Every stored 0x81 reveal pre-signed output 0 with the old value, so the worker
 * stops co-signing until an operator acknowledges through `POST /v1/admin/parent/ack`.
 */
export interface ParentValueAlert {
  at: string;
  /** What moved the parent: an (operator) initialise or a reveal advancing it. */
  reason: 'initialise' | 'advance';
  previous: ParentLocation;
  current: ParentLocation;
}

export interface ParentValueAcknowledgement {
  alert: ParentValueAlert;
  acknowledgedAt: string;
  /** Admin API key id that acknowledged. */
  acknowledgedBy: string;
  note?: string;
}

export type AcknowledgeResult =
  | { ok: true; acknowledged: ParentValueAcknowledgement | null; parent: ParentLocation }
  | { ok: false; reason: 'no_parent' | 'parent_mismatch'; parent: ParentLocation | null };

/**
 * The parent inscription lives in exactly one UTXO at a time and every reveal spends it, so the
 * provider hands out an exclusive lease. After a successful broadcast the new parent is output 0
 * of that reveal (`advance`); on failure the lease is released unchanged.
 *
 * Every change of the parent LOCATION (initialise, advance) is logged as `parent.lease.changed`; a change
 * of its VALUE additionally logs `parent.value.changed` at error level and opens `valueAlert()`.
 */
export interface ParentUtxoProvider {
  current(): Promise<ParentUtxo | null>;
  /** Exclusive lease for `orderId`; null when already leased by another order or unknown. */
  lease(orderId: string): Promise<ParentUtxo | null>;
  release(orderId: string): Promise<void>;
  advance(orderId: string, next: ParentUtxo): Promise<void>;
  markConfirmed(txid: string): Promise<void>;
  leasedBy(): Promise<string | null>;
  /** Non-null while the value circuit breaker is open (the worker does not co-sign). */
  valueAlert(): Promise<ParentValueAlert | null>;
  /**
   * Close the breaker. The caller names the parent it looked at (`outpoint`, `valueSats`); a mismatch with
   * the current parent is refused so a stale acknowledgement cannot resume co-signing on something else.
   */
  acknowledgeValueChange(ack: { outpoint: string; valueSats: number; by: string; at: Date; note?: string }): Promise<AcknowledgeResult>;
}
