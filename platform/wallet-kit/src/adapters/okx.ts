/**
 * OKX Wallet — one UniSat-compatible provider **per network**:
 * `window.okxwallet.bitcoin` (mainnet), `.bitcoinTestnet`, `.bitcoinSignet`.
 * The network is chosen by picking the provider, not by switching; the
 * returned address is still checked against the requested network.
 */
import { UnsupportedNetworkError, WalletError, WalletNotInstalledError } from '../errors.js';
import { account, assertAccountsOnNetwork, assertNetworkSupported, browserWindow, guard, isObject } from '../internal.js';
import type { ConnectedWallet, Network, WalletAdapter } from '../types.js';
import { unisatFamilyWallet, type UnisatFamilyProvider } from './unisat-family.js';

export interface OkxBitcoinProvider extends UnisatFamilyProvider {
  connect(): Promise<{ address: string; publicKey: string; compressedPublicKey?: string }>;
}

export const OKX_PROVIDER_KEY: Partial<Record<Network, 'bitcoin' | 'bitcoinTestnet' | 'bitcoinSignet'>> = {
  mainnet: 'bitcoin',
  testnet: 'bitcoinTestnet',
  signet: 'bitcoinSignet',
};

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet'];

function provider(network: Network): OkxBitcoinProvider | undefined {
  const okx = browserWindow()?.okxwallet;
  const key = OKX_PROVIDER_KEY[network];
  if (!isObject(okx) || !key) return undefined;
  const p = okx[key];
  return isObject(p) && typeof p.connect === 'function' ? (p as unknown as OkxBitcoinProvider) : undefined;
}

export const okxAdapter: WalletAdapter = {
  id: 'okx',
  name: 'OKX Wallet',
  installUrl: 'https://www.okx.com/web3',
  networks: NETWORKS,

  /** Installed if any network's provider is injected. */
  isInstalled: () => NETWORKS.some((n) => provider(n) !== undefined),

  async connect({ network }): Promise<ConnectedWallet> {
    assertNetworkSupported('okx', network, NETWORKS);
    if (!okxAdapter.isInstalled()) throw new WalletNotInstalledError('okx');
    const p = provider(network);
    if (!p) throw new UnsupportedNetworkError('okx', network, `This OKX Wallet build has no ${network} Bitcoin provider.`);

    const res = await guard('okx', () => p.connect());
    if (!res?.address) throw new WalletError('NOT_CONNECTED', 'OKX Wallet returned no account.', { walletId: 'okx' });
    const acct = account(res.address, res.publicKey ?? res.compressedPublicKey ?? '', 'payment');
    assertAccountsOnNetwork('okx', network, [acct]);

    return unisatFamilyWallet({
      id: 'okx',
      network,
      account: acct,
      provider: () => {
        const cur = provider(network);
        if (!cur) throw new WalletNotInstalledError('okx');
        return cur;
      },
      pushTxArg: (rawtx) => rawtx,
      changeEvents: ['accountChanged', 'accountsChanged'],
    });
  },
};
