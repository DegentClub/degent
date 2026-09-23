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

/**
 * The parent inscription lives in exactly one UTXO at a time and every reveal spends it, so the
 * provider hands out an exclusive lease. After a successful broadcast the new parent is output 0
 * of that reveal (`advance`); on failure the lease is released unchanged.
 */
export interface ParentUtxoProvider {
  current(): Promise<ParentUtxo | null>;
  /** Exclusive lease for `orderId`; null when already leased by another order or unknown. */
  lease(orderId: string): Promise<ParentUtxo | null>;
  release(orderId: string): Promise<void>;
  advance(orderId: string, next: ParentUtxo): Promise<void>;
  markConfirmed(txid: string): Promise<void>;
  leasedBy(): Promise<string | null>;
}
