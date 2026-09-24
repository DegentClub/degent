import { NETWORK, TEST_NETWORK } from '@scure/btc-signer';

export type Network = 'mainnet' | 'testnet' | 'signet' | 'regtest';

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef } as const;

export function networkParams(network: Network): typeof NETWORK {
  switch (network) {
    case 'mainnet':
      return NETWORK;
    case 'testnet':
    case 'signet':
      return TEST_NETWORK;
    case 'regtest':
      return REGTEST;
  }
}
