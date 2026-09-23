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
