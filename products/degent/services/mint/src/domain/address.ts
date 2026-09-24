/** Address sanity for the configured network. */
import { Address } from '@scure/btc-signer';
import { networkParams, type Network } from '@bsh/inscription';

export type AddressKind = 'tr' | 'wpkh' | 'wsh' | 'pkh' | 'sh' | 'other';

/** Decoded address type, or null when the address is invalid or for another network. */
export function addressKind(address: string, network: Network): AddressKind | null {
  if (typeof address !== 'string' || address.length < 14 || address.length > 100) return null;
  try {
    const d = Address(networkParams(network)).decode(address);
    return (['tr', 'wpkh', 'wsh', 'pkh', 'sh'] as const).includes(d.type as never) ? (d.type as AddressKind) : 'other';
  } catch {
    return null;
  }
}

/**
 * The child goes to the user's ordinals address, which must be taproot. Rejects other networks
 * (e.g. a tb1p address on mainnet) and non-taproot types with a message a user can act on.
 */
export function checkRecipientAddress(address: string, network: Network): string | null {
  const kind = addressKind(address, network);
  if (kind === null) return `recipientAddress is not a valid ${network} address`;
  if (kind !== 'tr') return 'recipientAddress must be a taproot (bc1p / tb1p / bcrt1p) ordinals address';
  return null;
}

/**
 * The one spelling of an address used for identity (order recipients, voters, sessions). Bech32 is
 * case-insensitive (BIP-173: all-lower or all-upper), so `BC1P…` and `bc1p…` are the same script; without
 * folding, one member could sign in twice and vote twice, and the self-vote rule could be dodged by case.
 * Base58 is case-sensitive and is returned unchanged.
 */
export function canonicalAddress(address: string): string {
  return /^(bc|tb|bcrt)1/i.test(address) ? address.toLowerCase() : address;
}
