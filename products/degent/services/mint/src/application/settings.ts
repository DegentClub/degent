import type { CollectionConfig, Network, Tier } from '@bsh/degent-mint-sdk';
import type { PolicyConfig } from '../domain/policy.js';

/** `collectionId` of every `collection.minted` event this service publishes (the product slug). */
export const COLLECTION_ID = 'degent';

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
  // ---- Open Studio (ADR-0007, plan §3) ----
  /** Artist royalty, basis points of the mint price (commitValue + clubFee). Default 1000. */
  royaltyBps: number;
  /** Club fee per tier, basis points of commitValue, paid to serviceFeeAddress. Default 1000 each. */
  clubFeeBps: Record<Tier, number>;
  /** Base URL of the Artist Studio (published in GET /v1/config); null when artwork orders are disabled. */
  studioUrl: string | null;
}
