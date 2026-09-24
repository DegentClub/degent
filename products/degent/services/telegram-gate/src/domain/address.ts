import { decodeAddress, type BitcoinNetwork } from '@bsh/identity';

/** True when the address decodes on `network` as a type SIWB can verify (p2tr, p2wpkh, p2pkh, p2sh-p2wpkh). */
export function isVerifiableAddress(address: unknown, network: BitcoinNetwork): address is string {
  if (typeof address !== 'string') return false;
  try {
    decodeAddress(address, network);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lookup key for the one-wallet-one-account rule. Bech32 is case-insensitive (BIP-173) so it folds to lower case;
 * base58 is case-sensitive and is kept as is.
 */
export function addressKey(address: string): string {
  return /^(bc1|tb1|bcrt1)/i.test(address) ? address.toLowerCase() : address;
}
