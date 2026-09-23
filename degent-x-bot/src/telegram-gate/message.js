// The exact message a holder signs with their wallet (BIP-322), and the
// verification wrapper around bip322-js.
//
// Format (five lines, LF separated, no trailing newline):
//
//   degent.club telegram
//   telegram:<tg user id>
//   address:<address>
//   nonce:<nonce>
//   expires:<iso>

const MESSAGE_HEADER = 'degent.club telegram';

function buildMessage({ telegramUserId, address, nonce, expires }) {
  if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) throw new Error('telegramUserId must be a positive integer');
  if (typeof address !== 'string' || !address) throw new Error('address required');
  if (typeof nonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(nonce)) throw new Error('nonce must be hex');
  const iso = expires instanceof Date ? expires.toISOString() : String(expires);
  if (Number.isNaN(Date.parse(iso))) throw new Error('expires must be a date');
  return [
    MESSAGE_HEADER,
    `telegram:${telegramUserId}`,
    `address:${address}`,
    `nonce:${nonce}`,
    `expires:${iso}`,
  ].join('\n');
}

/**
 * Parse a message back into its fields. Returns null when the shape is wrong.
 */
function parseMessage(message) {
  if (typeof message !== 'string') return null;
  const lines = message.split('\n');
  if (lines.length !== 5 || lines[0] !== MESSAGE_HEADER) return null;
  const take = (line, key) => (line.startsWith(`${key}:`) ? line.slice(key.length + 1) : null);
  const tg = take(lines[1], 'telegram');
  const address = take(lines[2], 'address');
  const nonce = take(lines[3], 'nonce');
  const expires = take(lines[4], 'expires');
  if (tg === null || address === null || nonce === null || expires === null) return null;
  if (!/^\d+$/.test(tg)) return null;
  return { telegramUserId: Number(tg), address, nonce, expires };
}

let verifier = null;
function loadVerifier() {
  if (!verifier) {
    // Lazy so that tests can inject their own verify function without
    // loading the elliptic-curve libraries.
    ({ Verifier: verifier } = require('bip322-js'));
  }
  return verifier;
}

/**
 * BIP-322 (simple) verification. Never throws; returns false on any error.
 */
function verifySignature(address, message, signatureBase64) {
  try {
    return loadVerifier().verifySignature(address, message, signatureBase64) === true;
  } catch {
    return false;
  }
}

/** Loose shape check before doing any crypto. */
function looksLikeBitcoinAddress(address) {
  return typeof address === 'string' && /^(bc1[a-z0-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i.test(address);
}

module.exports = { MESSAGE_HEADER, buildMessage, parseMessage, verifySignature, looksLikeBitcoinAddress };
