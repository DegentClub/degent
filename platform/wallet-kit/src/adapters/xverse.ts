/**
 * Xverse — `window.XverseProviders.BitcoinProvider` (sats-connect provider).
 * See ./sats-connect.ts for the dialect.
 */
import { browserWindow, isObject } from '../internal.js';
import type { WalletAdapter } from '../types.js';
import { type SatsConnectProvider, satsConnectAdapter } from './sats-connect.js';

function provider(): SatsConnectProvider | undefined {
  const providers = browserWindow()?.XverseProviders;
  const p = isObject(providers) ? providers.BitcoinProvider : undefined;
  return isObject(p) && typeof p.request === 'function' ? (p as unknown as SatsConnectProvider) : undefined;
}

export const xverseAdapter: WalletAdapter = satsConnectAdapter({
  id: 'xverse',
  name: 'Xverse',
  installUrl: 'https://www.xverse.app/download',
  networks: ['mainnet', 'testnet', 'signet', 'regtest'],
  provider,
});
