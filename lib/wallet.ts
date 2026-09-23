/**
 * Wallet adapters.
 *
 * One small interface, several implementations:
 *  - UniSat via its injected `window.unisat` API (supports `feeRate` on send).
 *  - Xverse, Leather, OKX and Magic Eden via the sats-connect JSON-RPC
 *    surface (`wallet_connect` / `getAccounts` / `sendTransfer`). Those
 *    wallets choose the payment fee in their own UI; the `feeRate` option is a
 *    hint we cannot enforce there.
 *
 * Every adapter reports the network it is on so the app can refuse anything
 * but mainnet before a quote is ever requested.
 */

export type WalletNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest' | 'unknown';

export interface ConnectedAccount {
  /** Address that will pay. */
  address: string;
  publicKey?: string;
  network: WalletNetwork;
  /** Address the wallet designates for ordinals, when it distinguishes one. */
  ordinalsAddress?: string;
}

export interface SendOptions {
  feeRate: number;
}

export interface WalletAdapter {
  id: string;
  name: string;
  installUrl: string;
  isInstalled(): boolean;
  connect(): Promise<ConnectedAccount>;
  disconnect(): Promise<void>;
  /** Broadcast a payment and resolve with the txid. */
  sendBitcoin(to: string, sats: number, opts: SendOptions): Promise<string>;
  /** Returns an unsubscribe function. */
  onAccountsChanged(handler: (accounts: string[]) => void): () => void;
}

export class WalletError extends Error {
  constructor(message: string, readonly code: 'not-installed' | 'rejected' | 'network' | 'unsupported' | 'unknown' = 'unknown') {
    super(message);
    this.name = 'WalletError';
  }
}

function assertPositiveInteger(sats: number): number {
  const amount = Math.trunc(Number(sats));
  if (!Number.isFinite(amount) || amount <= 0 || amount !== Number(sats)) {
    throw new WalletError(`Invalid amount: ${sats}. Must be a positive integer number of satoshis.`);
  }
  return amount;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

function isUserRejection(err: unknown): boolean {
  const msg = errorMessage(err, '').toLowerCase();
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
  return code === 4001 || code === -32000 || msg.includes('reject') || msg.includes('cancel') || msg.includes('denied');
}

/* ------------------------------------------------------------------------ */
/* UniSat                                                                    */
/* ------------------------------------------------------------------------ */

interface UnisatProvider {
  requestAccounts: () => Promise<string[]>;
  getAccounts: () => Promise<string[]>;
  getPublicKey?: () => Promise<string>;
  getNetwork?: () => Promise<string>;
  getChain?: () => Promise<{ enum: string; name: string; network: string }>;
  sendBitcoin: (address: string, amount: number, options?: { feeRate?: number }) => Promise<string>;
  disconnect?: () => Promise<void>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    unisat?: UnisatProvider;
  }
}

function unisatNetwork(value: string | undefined): WalletNetwork {
  switch ((value ?? '').toLowerCase()) {
    case 'livenet':
    case 'mainnet':
    case 'bitcoin_mainnet':
      return 'mainnet';
    case 'testnet':
    case 'testnet4':
    case 'bitcoin_testnet':
    case 'bitcoin_testnet4':
      return 'testnet';
    case 'signet':
    case 'bitcoin_signet':
      return 'signet';
    default:
      return 'unknown';
  }
}

export const unisatAdapter: WalletAdapter = {
  id: 'unisat',
  name: 'UniSat',
  installUrl: 'https://unisat.io/download',

  isInstalled() {
    return typeof window !== 'undefined' && typeof window.unisat !== 'undefined';
  },

  async connect() {
    const unisat = window.unisat;
    if (!unisat) throw new WalletError('UniSat wallet is not installed.', 'not-installed');
    let accounts: string[];
    try {
      accounts = await unisat.requestAccounts();
    } catch (err) {
      throw new WalletError(
        isUserRejection(err) ? 'Connection request was rejected in UniSat.' : errorMessage(err, 'UniSat connection failed.'),
        isUserRejection(err) ? 'rejected' : 'unknown'
      );
    }
    if (!accounts.length) throw new WalletError('UniSat returned no accounts.');

    let network: WalletNetwork = 'unknown';
    try {
      if (unisat.getChain) network = unisatNetwork((await unisat.getChain()).enum);
      if (network === 'unknown' && unisat.getNetwork) network = unisatNetwork(await unisat.getNetwork());
    } catch {
      network = 'unknown';
    }

    let publicKey: string | undefined;
    try {
      publicKey = await unisat.getPublicKey?.();
    } catch {
      publicKey = undefined;
    }

    return { address: accounts[0], publicKey, network };
  },

  async disconnect() {
    try {
      await window.unisat?.disconnect?.();
    } catch {
      // Older UniSat builds have no disconnect; nothing to do.
    }
  },

  async sendBitcoin(to, sats, opts) {
    const unisat = window.unisat;
    if (!unisat) throw new WalletError('UniSat wallet is not installed.', 'not-installed');
    const amount = assertPositiveInteger(sats);
    try {
      return await unisat.sendBitcoin(to, amount, { feeRate: opts.feeRate });
    } catch (err) {
      if (isUserRejection(err)) throw new WalletError('Payment was rejected in UniSat.', 'rejected');
      throw new WalletError(errorMessage(err, 'UniSat failed to send the payment.'));
    }
  },

  onAccountsChanged(handler) {
    const unisat = window.unisat;
    if (!unisat) return () => {};
    const listener = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      handler(accounts);
    };
    unisat.on('accountsChanged', listener);
    return () => unisat.removeListener('accountsChanged', listener);
  },
};

/* ------------------------------------------------------------------------ */
/* sats-connect wallets                                                      */
/* ------------------------------------------------------------------------ */

type SatsConnectModule = typeof import('sats-connect');

let satsConnectPromise: Promise<SatsConnectModule> | null = null;
function loadSatsConnect(): Promise<SatsConnectModule> {
  // Dynamic import keeps the wallet-selector UI bundle out of SSR and out of
  // the initial page load.
  if (!satsConnectPromise) satsConnectPromise = import('sats-connect');
  return satsConnectPromise;
}

interface SatsConnectWalletSpec {
  id: string;
  name: string;
  installUrl: string;
  /** Provider id as registered on window (dot path), e.g. "XverseProviders.BitcoinProvider". */
  providerIds: string[];
  /** Case-insensitive fragment matched against WBIP004 `window.btc_providers[].name`. */
  nameMatch: string;
}

function resolveByPath(path: string): unknown {
  if (typeof window === 'undefined') return undefined;
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, window);
}

function registeredProviders(): { id: string; name: string }[] {
  if (typeof window === 'undefined') return [];
  const list = (window as unknown as { btc_providers?: { id: string; name: string }[] }).btc_providers;
  return Array.isArray(list) ? list : [];
}

function findProviderId(spec: SatsConnectWalletSpec): string | null {
  const registered = registeredProviders().find((p) => p.name?.toLowerCase().includes(spec.nameMatch));
  if (registered && resolveByPath(registered.id)) return registered.id;
  for (const id of spec.providerIds) {
    if (resolveByPath(id)) return id;
  }
  return null;
}

function satsNetwork(name: string | undefined): WalletNetwork {
  switch (name) {
    case 'Mainnet':
      return 'mainnet';
    case 'Testnet':
    case 'Testnet4':
      return 'testnet';
    case 'Signet':
      return 'signet';
    case 'Regtest':
      return 'regtest';
    default:
      return 'unknown';
  }
}

function networkFromAddress(address: string): WalletNetwork {
  if (/^(bc1|[13])/.test(address)) return 'mainnet';
  if (/^(tb1|[mn2])/.test(address)) return 'testnet';
  if (/^bcrt1/.test(address)) return 'regtest';
  return 'unknown';
}

interface RpcAddress {
  address: string;
  publicKey: string;
  purpose: string;
  addressType: string;
}

function createSatsConnectAdapter(spec: SatsConnectWalletSpec): WalletAdapter {
  async function adapterFor(providerId: string) {
    const sc = await loadSatsConnect();
    const Adapter = (sc.defaultAdapters as Record<string, new () => { request: (m: string, p: unknown) => Promise<unknown>; addListener?: unknown }>)[providerId];
    return Adapter ? new Adapter() : new sc.BaseAdapter(providerId);
  }

  async function rpc<T>(providerId: string, method: string, params: unknown): Promise<{ ok: true; result: T } | { ok: false; code?: number; message: string }> {
    const adapter = await adapterFor(providerId);
    let response: unknown;
    try {
      response = await (adapter as { request: (m: string, p: unknown) => Promise<unknown> }).request(method, params);
    } catch (err) {
      return { ok: false, message: errorMessage(err, `${spec.name} request failed.`) };
    }
    const r = response as { status?: string; result?: T; error?: { code?: number; message?: string } } | undefined;
    if (r?.status === 'success') return { ok: true, result: r.result as T };
    return { ok: false, code: r?.error?.code, message: r?.error?.message ?? `${spec.name} request failed.` };
  }

  return {
    id: spec.id,
    name: spec.name,
    installUrl: spec.installUrl,

    isInstalled() {
      return findProviderId(spec) !== null;
    },

    async connect() {
      const providerId = findProviderId(spec);
      if (!providerId) throw new WalletError(`${spec.name} is not installed.`, 'not-installed');
      const sc = await loadSatsConnect();
      const purposes = [sc.AddressPurpose.Payment, sc.AddressPurpose.Ordinals];

      let addresses: RpcAddress[] = [];
      let network: WalletNetwork = 'unknown';

      const connected = await rpc<{ addresses: RpcAddress[]; network?: { bitcoin?: { name?: string } } }>(
        providerId,
        'wallet_connect',
        { addresses: purposes, message: 'Connect to Degen Minter', network: sc.BitcoinNetworkType.Mainnet }
      );

      if (connected.ok) {
        addresses = connected.result.addresses ?? [];
        network = satsNetwork(connected.result.network?.bitcoin?.name);
      } else if (connected.code === sc.RpcErrorCode.USER_REJECTION) {
        throw new WalletError(`Connection request was rejected in ${spec.name}.`, 'rejected');
      } else {
        // Older providers only know getAccounts.
        const accounts = await rpc<RpcAddress[]>(providerId, 'getAccounts', {
          purposes,
          message: 'Connect to Degen Minter',
        });
        if (!accounts.ok) {
          throw new WalletError(
            accounts.code === sc.RpcErrorCode.USER_REJECTION
              ? `Connection request was rejected in ${spec.name}.`
              : accounts.message,
            accounts.code === sc.RpcErrorCode.USER_REJECTION ? 'rejected' : 'unknown'
          );
        }
        addresses = accounts.result ?? [];
      }

      const payment = addresses.find((a) => a.purpose === 'payment') ?? addresses[0];
      const ordinals = addresses.find((a) => a.purpose === 'ordinals');
      if (!payment) throw new WalletError(`${spec.name} returned no Bitcoin address.`);

      if (network === 'unknown') {
        const net = await rpc<{ bitcoin?: { name?: string } }>(providerId, 'wallet_getNetwork', null);
        network = net.ok ? satsNetwork(net.result.bitcoin?.name) : networkFromAddress(payment.address);
      }

      return {
        address: payment.address,
        publicKey: payment.publicKey,
        network,
        ordinalsAddress: ordinals?.address,
      };
    },

    async disconnect() {
      const providerId = findProviderId(spec);
      if (!providerId) return;
      await rpc(providerId, 'wallet_disconnect', null).catch(() => undefined);
    },

    async sendBitcoin(to, sats, _opts) {
      const providerId = findProviderId(spec);
      if (!providerId) throw new WalletError(`${spec.name} is not installed.`, 'not-installed');
      const amount = assertPositiveInteger(sats);
      const sc = await loadSatsConnect();
      // sendTransfer has no fee-rate parameter; the wallet picks it in its own UI.
      const res = await rpc<{ txid: string }>(providerId, 'sendTransfer', { recipients: [{ address: to, amount }] });
      if (!res.ok) {
        if (res.code === sc.RpcErrorCode.USER_REJECTION) throw new WalletError(`Payment was rejected in ${spec.name}.`, 'rejected');
        throw new WalletError(res.message);
      }
      if (!res.result?.txid) throw new WalletError(`${spec.name} did not return a transaction id.`);
      return res.result.txid;
    },

    onAccountsChanged(handler) {
      const providerId = findProviderId(spec);
      if (!providerId) return () => {};
      let unsubscribe: (() => void) | null = null;
      let cancelled = false;
      loadSatsConnect()
        .then(async (sc) => {
          if (cancelled) return;
          try {
            const adapter = await adapterFor(providerId);
            const addListener = (adapter as { addListener?: (info: unknown) => () => void }).addListener;
            if (typeof addListener !== 'function') return;
            unsubscribe = addListener.call(adapter, {
              eventName: sc.accountChangeEventName ?? 'accountChange',
              cb: (event: { addresses?: RpcAddress[] }) => handler((event.addresses ?? []).map((a) => a.address)),
            });
          } catch {
            // Provider without event support; the user can reconnect manually.
          }
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        unsubscribe?.();
      };
    },
  };
}

export const xverseAdapter = createSatsConnectAdapter({
  id: 'xverse',
  name: 'Xverse',
  installUrl: 'https://www.xverse.app/download',
  providerIds: ['XverseProviders.BitcoinProvider'],
  nameMatch: 'xverse',
});

export const leatherAdapter = createSatsConnectAdapter({
  id: 'leather',
  name: 'Leather',
  installUrl: 'https://leather.io/install-extension',
  providerIds: ['LeatherProvider'],
  nameMatch: 'leather',
});

export const okxAdapter = createSatsConnectAdapter({
  id: 'okx',
  name: 'OKX Wallet',
  installUrl: 'https://www.okx.com/web3',
  providerIds: ['okxwallet.bitcoin'],
  nameMatch: 'okx',
});

export const magicEdenAdapter = createSatsConnectAdapter({
  id: 'magiceden',
  name: 'Magic Eden',
  installUrl: 'https://wallet.magiceden.io/',
  providerIds: ['magicEden.bitcoin'],
  nameMatch: 'magic eden',
});

export const walletAdapters: WalletAdapter[] = [unisatAdapter, xverseAdapter, leatherAdapter, okxAdapter, magicEdenAdapter];

export function getAdapter(id: string): WalletAdapter | undefined {
  return walletAdapters.find((a) => a.id === id);
}

export const LAST_WALLET_KEY = 'degen-minter:last-wallet';

export function rememberWallet(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(LAST_WALLET_KEY, id);
    else window.localStorage.removeItem(LAST_WALLET_KEY);
  } catch {
    // ignore
  }
}

export function rememberedWallet(): string | null {
  try {
    return window.localStorage.getItem(LAST_WALLET_KEY);
  } catch {
    return null;
  }
}
