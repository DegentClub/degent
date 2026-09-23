import { NETWORK, TEST_NETWORK } from '@scure/btc-signer';

/** Bitcoin networks a Blockspace ID wallet can live on. */
export type BitcoinNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export const BITCOIN_NETWORKS: readonly BitcoinNetwork[] = Object.freeze(['mainnet', 'testnet', 'signet', 'regtest']);

export interface BtcNetworkParams {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
}

const REGTEST: BtcNetworkParams = Object.freeze({ bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef });

export function isBitcoinNetwork(v: unknown): v is BitcoinNetwork {
  return typeof v === 'string' && (BITCOIN_NETWORKS as readonly string[]).includes(v);
}

/** btc-signer address parameters for a network name. testnet and signet share encodings. */
export function networkParams(network: BitcoinNetwork): BtcNetworkParams {
  switch (network) {
    case 'mainnet':
      return NETWORK;
    case 'testnet':
    case 'signet':
      return TEST_NETWORK;
    case 'regtest':
      return REGTEST;
    default:
      throw new Error(`unknown network: ${String(network)}`);
  }
}
