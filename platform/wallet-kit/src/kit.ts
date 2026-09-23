import { WalletError, toWalletError } from './errors.js';
import { ADAPTERS, detectWallets } from './registry.js';
import type { ConnectedWallet, Network, WalletAdapter, WalletId } from './types.js';

export type DisconnectReason = 'user' | 'replaced' | 'accountsChanged';

export interface WalletKitEvents {
  connect: ConnectedWallet;
  disconnect: { id: WalletId; reason: DisconnectReason };
  /** The wallet switched account or network; the kit drops the session right after. */
  accountsChanged: { id: WalletId };
  error: { id: WalletId; error: WalletError };
}

export type WalletKitEvent = keyof WalletKitEvents;

export interface WalletKitOptions {
  network: Network;
  /** Override the adapter set (tests, or to hide a wallet). Defaults to all built-ins. */
  adapters?: readonly WalletAdapter[];
}

export interface WalletKit {
  readonly network: Network;
  readonly adapters: readonly WalletAdapter[];
  /** The live session, or null. */
  readonly current: ConnectedWallet | null;
  /** Adapters installed in this page (evaluated on each call; extensions inject late). */
  detect(): WalletAdapter[];
  connect(id: WalletId): Promise<ConnectedWallet>;
  disconnect(): Promise<void>;
  on<E extends WalletKitEvent>(event: E, cb: (payload: WalletKitEvents[E]) => void): () => void;
}

export function createWalletKit(opts: WalletKitOptions): WalletKit {
  const { network } = opts;
  const adapters = Object.freeze([...(opts.adapters ?? ADAPTERS)]);
  const listeners: { [E in WalletKitEvent]: Set<(p: WalletKitEvents[E]) => void> } = {
    connect: new Set(),
    disconnect: new Set(),
    accountsChanged: new Set(),
    error: new Set(),
  };
  let current: ConnectedWallet | null = null;
  let inner: ConnectedWallet | null = null;
  let unsubscribe: (() => void) | null = null;
  // Monotonic token so a slow connect that loses a race cannot overwrite a newer session.
  let epoch = 0;

  function emit<E extends WalletKitEvent>(event: E, payload: WalletKitEvents[E]): void {
    for (const cb of [...listeners[event]]) {
      try {
        cb(payload);
      } catch {
        /* a throwing listener must not break the kit or other listeners */
      }
    }
  }

  async function drop(reason: DisconnectReason): Promise<void> {
    const w = inner;
    if (!w) return;
    unsubscribe?.();
    unsubscribe = null;
    current = null;
    inner = null;
    try {
      await w.disconnect();
    } finally {
      emit('disconnect', { id: w.id, reason });
    }
  }

  const kit: WalletKit = {
    network,
    adapters,
    get current() {
      return current;
    },
    detect: () => detectWallets(adapters),

    async connect(id: WalletId) {
      const adapter = adapters.find((a) => a.id === id);
      if (!adapter) throw new WalletError('UNKNOWN_WALLET', `Wallet "${String(id)}" is not available in this kit.`);
      const mine = ++epoch;
      let wallet: ConnectedWallet;
      try {
        wallet = await adapter.connect({ network });
      } catch (e) {
        const error = toWalletError(e, id);
        emit('error', { id, error });
        throw error;
      }
      if (mine !== epoch) {
        // A newer connect() started while this one was pending; it wins.
        await wallet.disconnect().catch(() => undefined);
        throw new WalletError('WALLET_ERROR', `Connect to ${id} was superseded by a newer request.`, { walletId: id });
      }
      await drop('replaced');
      inner = wallet;
      const exposed: ConnectedWallet = { ...wallet, disconnect: () => (inner === wallet ? drop('user') : wallet.disconnect()) };
      current = exposed;
      if (wallet.onAccountsChanged) {
        unsubscribe = wallet.onAccountsChanged(() => {
          if (inner !== wallet) return;
          emit('accountsChanged', { id: wallet.id });
          void drop('accountsChanged');
        });
      }
      emit('connect', exposed);
      return exposed;
    },

    disconnect: () => drop('user'),

    on(event, cb) {
      listeners[event].add(cb);
      return () => {
        listeners[event].delete(cb);
      };
    },
  };
  return kit;
}
