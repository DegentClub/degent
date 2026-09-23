// Bitcoin address detection for outbound content.
//
// The bot must never post anything that looks like a wallet address — that's
// how address-swap scams start. The patterns are intentionally loose on
// checksum (we don't validate) and strict on shape.
//
//   bech32 / bech32m (P2WPKH, P2WSH, P2TR): bc1 + 11..71 chars of the bech32 charset
//   P2SH:  3 + 25..34 base58 chars
//   P2PKH: 1 + 25..34 base58 chars

const BECH32_CHARSET = 'ac-hj-np-z02-9';
const BASE58_CHARSET = 'a-km-zA-HJ-NP-Z1-9';

// Address must not be glued to other alphanumerics on either side.
const LEFT_BOUNDARY = '(?<![A-Za-z0-9])';
const RIGHT_BOUNDARY = '(?![A-Za-z0-9])';

const BECH32_SOURCE = `bc1[${BECH32_CHARSET}]{11,71}`;
const P2SH_SOURCE = `3[${BASE58_CHARSET}]{25,34}`;
const P2PKH_SOURCE = `1[${BASE58_CHARSET}]{25,34}`;

// bc1 is case-insensitive per BIP-173 (all-lower or all-upper); base58 is not.
const BECH32_REGEX = new RegExp(`${LEFT_BOUNDARY}${BECH32_SOURCE}${RIGHT_BOUNDARY}`, 'i');
const BASE58_REGEX = new RegExp(`${LEFT_BOUNDARY}(?:${P2SH_SOURCE}|${P2PKH_SOURCE})${RIGHT_BOUNDARY}`);

/**
 * @param {string} text
 * @returns {boolean} true when the text contains something shaped like a BTC address
 */
function containsBitcoinAddress(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return BECH32_REGEX.test(text) || BASE58_REGEX.test(text);
}

/**
 * @param {string} text
 * @returns {string[]} every address-shaped token found
 */
function findBitcoinAddresses(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const bech = text.match(new RegExp(BECH32_REGEX.source, 'gi')) || [];
  const b58 = text.match(new RegExp(BASE58_REGEX.source, 'g')) || [];
  return [...bech, ...b58];
}

module.exports = {
  containsBitcoinAddress,
  findBitcoinAddresses,
  BECH32_REGEX,
  BASE58_REGEX,
};
