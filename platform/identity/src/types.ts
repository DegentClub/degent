import type { BitcoinNetwork } from './network.js';

/** A wallet proven (via SIWB) to be controlled by the identity. */
export interface LinkedWallet {
  address: string;
  network: BitcoinNetwork;
  /** ISO-8601 time of the successful SIWB verification that linked it. */
  verifiedAt: string;
  /** How ownership was proven. */
  method?: 'bip322-simple' | 'legacy';
}

/**
 * One Blockspace ID across every product. `id` is an opaque, stable identifier (never an address:
 * wallets can be unlinked). Products store their own data keyed by `id`.
 */
export interface BlockspaceIdentity {
  id: string;
  wallets: LinkedWallet[];
  email?: string;
  createdAt?: string;
}

/** Link a newly verified wallet (idempotent per address+network; refreshes verifiedAt). */
export function linkWallet(identity: BlockspaceIdentity, wallet: LinkedWallet): BlockspaceIdentity {
  const others = identity.wallets.filter((w) => !(w.address === wallet.address && w.network === wallet.network));
  return { ...identity, wallets: [...others, wallet] };
}

export function unlinkWallet(identity: BlockspaceIdentity, address: string, network: BitcoinNetwork): BlockspaceIdentity {
  return { ...identity, wallets: identity.wallets.filter((w) => !(w.address === address && w.network === network)) };
}
