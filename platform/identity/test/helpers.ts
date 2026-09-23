import { NETWORK, WIF, getAddress, TEST_NETWORK } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { networkParams, type BitcoinNetwork } from '../src/network.js';

/** Private key published in BIP-322's test vectors (and the address it controls). */
export const BIP322_WIF = 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k';
export const BIP322_PRIV = WIF(NETWORK).decode(BIP322_WIF);
export const BIP322_P2WPKH = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
export const BIP322_P2TR = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3';

/** Deterministic test keys (never use outside tests). */
export const key = (n: number): Uint8Array => hex.decode(n.toString(16).padStart(64, '0'));

export function addr(kind: 'wpkh' | 'tr' | 'pkh', priv: Uint8Array, network: BitcoinNetwork = 'mainnet'): string {
  return getAddress(kind, priv, networkParams(network) as typeof TEST_NETWORK);
}

export function flipBase64Byte(b64: string, index: number): string {
  const raw = Buffer.from(b64, 'base64');
  raw[index] = raw[index]! ^ 0x01;
  return raw.toString('base64');
}
