import type { Network } from '@bsh/degent-market-sdk';

export interface MarketSettings {
  network: Network;
  version: string;
  /** Kill switch: false → /v1/buy/* answers 503 `buys_paused` (default). */
  buysEnabled: boolean;
  royaltyBps: number;
  treasuryAddress: string | null;
  priceMinSats: number;
  priceMaxSats: number;
  listingMaxDays: number;
  dummyValueSats: number;
  challengeTtlSeconds: number;
  buySessionTtlSeconds: number;
  pendingTimeoutMs: number;
  /** Ask ord whether each buyer UTXO carries an inscription before spending it as payment. */
  utxoSafetyCheck: boolean;
  explorerTxUrl: string;
  auth: { domain: string; uri: string | null };
}
