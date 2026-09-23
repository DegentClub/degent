import { Address, OutScript } from '@scure/btc-signer';
import { networkParams, type BitcoinNetwork } from './network.js';

/** Address kinds Blockspace ID can verify ownership of. */
export type AddressKind = 'p2tr' | 'p2wpkh' | 'p2pkh' | 'p2sh';

export interface DecodedAddress {
  address: string;
  network: BitcoinNetwork;
  kind: AddressKind;
  /** scriptPubKey. */
  script: Uint8Array;
  /** Witness program / hash: 32-byte output key (p2tr), 20-byte hash (p2wpkh, p2pkh, p2sh). */
  program: Uint8Array;
}

/**
 * Decode an address for a given network. Throws if the address is malformed, belongs to another
 * network, or is a type we cannot verify (p2wsh, p2tr script-only, future witness versions).
 */
export function decodeAddress(address: string, network: BitcoinNetwork): DecodedAddress {
  if (typeof address !== 'string' || address.length < 14 || address.length > 90) throw new Error('invalid address');
  // Mainnet bech32 lower-case only: mixed/upper case would be a distinct string for the same key.
  if (address !== address.trim()) throw new Error('invalid address');
  let decoded: ReturnType<ReturnType<typeof Address>['decode']>;
  try {
    decoded = Address(networkParams(network)).decode(address);
  } catch {
    throw new Error(`invalid ${network} address`);
  }
  const script = OutScript.encode(decoded as Parameters<typeof OutScript.encode>[0]);
  switch (decoded.type) {
    case 'tr':
      return { address, network, kind: 'p2tr', script, program: Uint8Array.from(decoded.pubkey) };
    case 'wpkh':
      return { address, network, kind: 'p2wpkh', script, program: Uint8Array.from(decoded.hash) };
    case 'pkh':
      return { address, network, kind: 'p2pkh', script, program: Uint8Array.from(decoded.hash) };
    case 'sh':
      return { address, network, kind: 'p2sh', script, program: Uint8Array.from(decoded.hash) };
    default:
      throw new Error(`unsupported address type: ${decoded.type}`);
  }
}
