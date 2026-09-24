/**
 * Bitcoin address detection for outbound content. The bot must never post anything shaped like a wallet address:
 * that is how address-swap scams start. Loose on checksum (not validated), strict on shape.
 *
 *   bech32 / bech32m (P2WPKH, P2WSH, P2TR): bc1 + 11..71 chars of the bech32 charset (case-insensitive, BIP-173)
 *   P2SH:  3 + 25..34 base58 chars
 *   P2PKH: 1 + 25..34 base58 chars
 */
const BECH32_CHARSET = 'ac-hj-np-z02-9';
const BASE58_CHARSET = 'a-km-zA-HJ-NP-Z1-9';

// An address must not be glued to other alphanumerics on either side.
const LEFT_BOUNDARY = '(?<![A-Za-z0-9])';
const RIGHT_BOUNDARY = '(?![A-Za-z0-9])';

const BECH32_SOURCE = `bc1[${BECH32_CHARSET}]{11,71}`;
const P2SH_SOURCE = `3[${BASE58_CHARSET}]{25,34}`;
const P2PKH_SOURCE = `1[${BASE58_CHARSET}]{25,34}`;

export const BECH32_REGEX = new RegExp(`${LEFT_BOUNDARY}${BECH32_SOURCE}${RIGHT_BOUNDARY}`, 'i');
export const BASE58_REGEX = new RegExp(`${LEFT_BOUNDARY}(?:${P2SH_SOURCE}|${P2PKH_SOURCE})${RIGHT_BOUNDARY}`);

/** True when the text contains something shaped like a BTC address. */
export function containsBitcoinAddress(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return BECH32_REGEX.test(text) || BASE58_REGEX.test(text);
}

/** Every address-shaped token in the text. */
export function findBitcoinAddresses(text: unknown): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const bech = text.match(new RegExp(BECH32_REGEX.source, 'gi')) ?? [];
  const b58 = text.match(new RegExp(BASE58_REGEX.source, 'g')) ?? [];
  return [...bech, ...b58];
}
