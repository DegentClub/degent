/** Real WalletService: delegates to @bsh/wallet-kit (UniSat, Xverse, Leather, OKX, Magic Eden). */
import { ADAPTERS, createWalletKit, type ConnectedWallet, type WalletKit } from '@bsh/wallet-kit';
import type { Network } from '@bsh/degent-mint-sdk';
import type { WalletService, WalletSession } from '../types';

function toSession(w: ConnectedWallet, name: string): WalletSession {
  const session: WalletSession = {
    id: w.id,
    name,
    network: w.network,
    ordinals: { address: w.ordinals.address, publicKey: w.ordinals.publicKey, addressType: w.ordinals.addressType },
    payment: { address: w.payment.address, publicKey: w.payment.publicKey, addressType: w.payment.addressType },
    signPsbt: (psbt, req) => w.signPsbt(psbt, req),
    signMessage: (message, address, type) => w.signMessage(message, address, type ?? 'bip322-simple'),
    disconnect: () => w.disconnect(),
  };
  if (w.pushTx) session.pushTx = (hex) => w.pushTx!(hex);
  return session;
}

export function createRealWallets(): WalletService {
  const kits = new Map<Network, WalletKit>();
  const kitFor = (network: Network) => {
    let k = kits.get(network);
    if (!k) {
      k = createWalletKit({ network });
      kits.set(network, k);
    }
    return k;
  };
  return {
    list() {
      return ADAPTERS.map((a) => {
        let installed = false;
        try {
          installed = a.isInstalled();
        } catch {
          installed = false;
        }
        return { id: a.id, name: a.name, installed, installUrl: a.installUrl, ...(a.icon ? { icon: a.icon } : {}) };
      });
    },
    async connect(id, network) {
      const adapter = ADAPTERS.find((a) => a.id === id);
      const w = await kitFor(network).connect(id);
      return toSession(w, adapter?.name ?? id);
    },
  };
}
