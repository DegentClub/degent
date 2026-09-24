/**
 * Read/broadcast view of the chain (esplora / mempool.space-compatible). Adapters throw
 * `UpstreamError` when the backend is unreachable; "unknown" is a null result, never an exception.
 */
export interface Outspend {
  spent: boolean;
  /** Spending txid when spent. */
  txid: string | null;
}

export interface ChainTxOutput {
  value: bigint;
  scriptHex: string;
  address: string | null;
}

export interface ChainTx {
  txid: string;
  vout: ChainTxOutput[];
  confirmed: boolean;
}

export interface AddressUtxo {
  txid: string;
  vout: number;
  value: bigint;
  confirmed: boolean;
}

export interface MarketChain {
  /** Null when the outpoint is unknown to the backend. */
  getOutspend(txid: string, vout: number): Promise<Outspend | null>;
  getTx(txid: string): Promise<ChainTx | null>;
  getAddressUtxos(address: string): Promise<AddressUtxo[]>;
  /** mempool.space `/v1/fees/recommended` shape (fastestFee, halfHourFee, hourFee, economyFee, minimumFee). */
  getFeeRecommendations(): Promise<Record<string, unknown> | null>;
  /** Broadcast a raw transaction; returns its txid. Throws `BroadcastRejected` when the node refuses it. */
  broadcast(rawTxHex: string): Promise<string>;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class BroadcastRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastRejected';
  }
}
