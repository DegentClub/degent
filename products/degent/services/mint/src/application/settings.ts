import type { CollectionConfig, Network } from '@bsh/degent-mint-sdk';
import type { PolicyConfig } from '../domain/policy.js';

/** Runtime settings shared by the API and the worker (built by config.ts or by tests). */
export interface MintSettings {
  network: Network;
  version: string;
  collection: CollectionConfig;
  /** P2TR address holding the parent inscription (== policy signer key's address). */
  collectionAddress: string;
  serviceFeeAddress: string | null;
  maxUploadBytes: number;
  /** Standard lane: max reveals in flight (revealing + revealed-unconfirmed). <= 24 (mempool chain limit). */
  standardConcurrency: number;
  confirmations: number;
  /** Keep watching expired orders for a late commit this long after expiry. */
  latePaymentWindowSeconds: number;
  policy: PolicyConfig;
}
