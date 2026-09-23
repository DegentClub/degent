import { NETWORK, TEST_NETWORK } from '@scure/btc-signer';

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export interface BtcNetworkParams {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
}

const REGTEST: BtcNetworkParams = Object.freeze({ bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef });

/** btc-signer network parameters for a network name. */
export function networkParams(network: Network): BtcNetworkParams {
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
