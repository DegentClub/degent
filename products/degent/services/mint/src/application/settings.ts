import type { CollectionConfig, Network } from '@bsh/degent-mint-sdk';
import type { ApprovalConfig } from '../domain/approval.js';
import type { PolicyConfig } from '../domain/policy.js';

/** Holder sign-in (SIWB via @bsh/identity) and session settings. */
export interface AuthSettings {
  /** SIWB domain the challenge is bound to (lower-case host[:port]), e.g. `degent.club`. */
  domain: string;
  /** URI in the challenge; defaults to `https://<domain>` (http only for loopback). */
  uri: string | null;
  challengeTtlSeconds: number;
  sessionTtlSeconds: number;
  /** JWT audience / product slug. */
  audience: string;
}

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
  /** Member approval (ADR-0005): quorums, review SLA, Gallery size. */
  approval: ApprovalConfig;
  auth: AuthSettings;
  /** Public ord base for explorer image URLs (`<ordPublicUrl>/content/<id>`). */
  ordPublicUrl: string;
  /** Inscription id of the signed Gallery (docs/REGISTER.md §1.2) once the owner inscribed it. */
  galleryInscriptionId: string | null;
}
