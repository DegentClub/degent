import type { CollectionConfig, Network } from '@bsh/degent-mint-sdk';
import type { PolicyConfig } from '../domain/policy.js';

/** Runtime settings shared by the API and the worker (built by config.ts or by tests). */
export interface MintSettings {
  network: Network;
  version: string;
  collection: CollectionConfig;
  /** P2TR address holding the parent inscription (== policy signer key's address). */
  collectionAddress: string;
  /**
   * The parent UTXO's constant value (sats). Every reveal returns exactly this much to
   * `collectionAddress` in output 0, and the browser signs that output up front (0x81, ADR-0005).
   * The worker refuses to reveal on a parent UTXO whose value differs.
   */
  parentValueSats: number;
  serviceFeeAddress: string | null;
  maxUploadBytes: number;
  /** Standard lane: max reveals in flight (revealing + revealed-unconfirmed). <= 24 (mempool chain limit). */
  standardConcurrency: number;
  confirmations: number;
  /** Keep watching expired orders for a late commit this long after expiry. */
  latePaymentWindowSeconds: number;
  policy: PolicyConfig;
}
