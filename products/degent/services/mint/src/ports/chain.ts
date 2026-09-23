/** Read-only view of the chain and of ord (esplora / mempool-compatible + ord /content). */
export interface ChainTxOutput {
  value: bigint;
  scriptHex: string;
  address: string | null;
}

export interface ChainTx {
  txid: string;
  vout: ChainTxOutput[];
  confirmed: boolean;
  blockHeight: number | null;
}

export interface ChainOutspend {
  spent: boolean;
  txid: string | null;
  vin: number | null;
}

export interface AddressOutput {
  txid: string;
  vout: number;
  value: bigint;
  confirmed: boolean;
}

export interface ChainPort {
  /** Null when the node/indexer does not know the tx (neither mempool nor chain). */
  getTx(txid: string): Promise<ChainTx | null>;
  /** One entry per output of `txid`. Null when the tx is unknown. */
  getTxOutspends(txid: string): Promise<ChainOutspend[] | null>;
  /** Unspent outputs paying `address` (mempool included). */
  findOutputsPaying(address: string): Promise<AddressOutput[]>;
  getTipHeight(): Promise<number>;
  /** Exact inscription body as served by ord `/content/<id>`; null when not indexed (yet). */
  getInscriptionContent(inscriptionId: string): Promise<Uint8Array | null>;
}
