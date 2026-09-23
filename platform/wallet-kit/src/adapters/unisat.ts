/**
 * UniSat — `window.unisat`.
 *
 * Network: prefers the chain API (`getChain` / `switchChain` with
 * `BITCOIN_MAINNET` / `BITCOIN_TESTNET4` / `BITCOIN_SIGNET`); falls back to the
 * older `getNetwork` / `switchNetwork` (`livenet` / `testnet`), which cannot
 * select signet. Unlike the legacy ordinals-mint adapter (which switched
 * best-effort and ignored failure), the chain is **verified** after switching
 * and the returned address is checked against the requested network.
 */
import { UnsupportedNetworkError, WalletError, WalletNotInstalledError, toWalletError } from '../errors.js';
import { account, assertAccountsOnNetwork, assertNetworkSupported, browserWindow, guard, isObject } from '../internal.js';
import type { ConnectedWallet, Network, WalletAdapter } from '../types.js';
import { unisatFamilyWallet, type UnisatFamilyProvider } from './unisat-family.js';

export interface UnisatChainInfo {
  enum: string;
  name?: string;
  network?: string;
}

export interface UnisatProvider extends UnisatFamilyProvider {
  requestAccounts(): Promise<string[]>;
  getAccounts?(): Promise<string[]>;
  getPublicKey(): Promise<string>;
  getChain?(): Promise<UnisatChainInfo>;
  switchChain?(chain: string): Promise<UnisatChainInfo>;
  getNetwork?(): Promise<string>;
  switchNetwork?(network: string): Promise<string>;
}

export const UNISAT_CHAIN: Partial<Record<Network, string>> = {
  mainnet: 'BITCOIN_MAINNET',
  testnet: 'BITCOIN_TESTNET4',
  signet: 'BITCOIN_SIGNET',
};

/** Legacy `getNetwork` values. Signet has none. */
const UNISAT_LEGACY_NETWORK: Partial<Record<Network, string>> = {
  mainnet: 'livenet',
  testnet: 'testnet',
};

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet'];

function provider(): UnisatProvider | undefined {
  const p = browserWindow()?.unisat;
  return isObject(p) && typeof p.requestAccounts === 'function' ? (p as unknown as UnisatProvider) : undefined;
}

function chainEnum(info: unknown): string | undefined {
  return isObject(info) && typeof info.enum === 'string' ? info.enum : undefined;
}

async function ensureNetwork(p: UnisatProvider, network: Network): Promise<boolean> {
  if (typeof p.getChain === 'function' && typeof p.switchChain === 'function') {
    const want = UNISAT_CHAIN[network]!;
    if (chainEnum(await guard('unisat', () => p.getChain!())) === want) return false;
    try {
      await p.switchChain(want);
    } catch (e) {
      const mapped = toWalletError(e, 'unisat');
      if (mapped.code === 'USER_REJECTED') throw mapped;
      throw new UnsupportedNetworkError('unisat', network, `UniSat could not switch to ${network}: ${mapped.message}`);
    }
    const now = chainEnum(await guard('unisat', () => p.getChain!()));
    if (now !== want) {
      throw new UnsupportedNetworkError('unisat', network, `UniSat is on ${now ?? 'an unknown chain'}, expected ${want}.`);
    }
    return true;
  }
  if (typeof p.getNetwork === 'function' && typeof p.switchNetwork === 'function') {
    const want = UNISAT_LEGACY_NETWORK[network];
    if (!want) {
      throw new UnsupportedNetworkError('unisat', network, `This UniSat version cannot select ${network}; please update the extension.`);
    }
    if ((await guard('unisat', () => p.getNetwork!())) === want) return false;
    await guard('unisat', () => p.switchNetwork!(want));
    const now = await guard('unisat', () => p.getNetwork!());
    if (now !== want) throw new UnsupportedNetworkError('unisat', network, `UniSat is on ${now}, expected ${want}.`);
    return true;
  }
  // No network API at all: fall through to the address-prefix check.
  return false;
}

export const unisatAdapter: WalletAdapter = {
  id: 'unisat',
  name: 'UniSat Wallet',
  installUrl: 'https://unisat.io/download',
  networks: NETWORKS,

  isInstalled: () => provider() !== undefined,

  async connect({ network }): Promise<ConnectedWallet> {
    assertNetworkSupported('unisat', network, NETWORKS);
    const p = provider();
    if (!p) throw new WalletNotInstalledError('unisat');

    let accounts = await guard('unisat', () => p.requestAccounts());
    const switched = await ensureNetwork(p, network);
    // Switching chain can change the active address (tb1… vs bc1…); read it again.
    if (switched) accounts = await guard('unisat', () => p.requestAccounts());
    const address = accounts?.[0];
    if (!address) throw new WalletError('NOT_CONNECTED', 'UniSat returned no accounts.', { walletId: 'unisat' });
    const publicKey = await guard('unisat', () => p.getPublicKey());

    const acct = account(address, publicKey, 'payment');
    assertAccountsOnNetwork('unisat', network, [acct]);

    return unisatFamilyWallet({
      id: 'unisat',
      network,
      account: acct,
      provider: () => {
        const cur = provider();
        if (!cur) throw new WalletNotInstalledError('unisat');
        return cur;
      },
      pushTxArg: (rawtx) => ({ rawtx }),
      changeEvents: ['accountsChanged', 'networkChanged', 'chainChanged'],
    });
  },
};
