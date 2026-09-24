import type { CollectionConfig, Network } from '@bsh/degent-mint-sdk';

export interface StudioSettings {
  network: Network;
  version: string;
  /** Collection rules the studio validates against (DEGENT_RULES_CONFIG with the network). */
  rules: CollectionConfig;
  maxUploadBytes: number;
  siwb: {
    /** Lower-case host[:port] the challenge is bound to. */
    domain: string;
    /** `https://<domain>` (http only for loopback). */
    uri: string;
    ttlSeconds: number;
    statement: string | null;
  };
  session: {
    ttlSeconds: number;
    issuer: string;
    /** JWT audience == product slug. */
    audience: 'degent';
    scopes: readonly string[];
  };
  /** Absolute base for contentUrl; empty = relative. */
  publicBaseUrl: string;
  /** Name of the vision reviewer in use, reported in GET /v1/config. */
  visionReview: 'claude' | 'none';
}
