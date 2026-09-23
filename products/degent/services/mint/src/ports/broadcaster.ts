import type { Lane } from '@bsh/degent-mint-sdk';

export type BroadcastResult = { ok: true; txid: string; via: string } | { ok: false; error: string; retryable: boolean; via: string };

/**
 * Pushes a raw transaction through one relay path.
 *   'standard' lane -> esplora/mempool-compatible POST /tx
 *   'block' lane    -> Libre Relay node `sendrawtransaction` and/or MARA Slipstream
 * Implementations never throw for relay rejections; they return { ok: false }.
 */
export interface Broadcaster {
  readonly name: string;
  broadcast(txHex: string): Promise<BroadcastResult>;
}

export type LaneBroadcasters = Record<Lane, Broadcaster>;
