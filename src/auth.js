// Ownership proof for listing create / cancel: BIP-322 "simple" message
// signatures (UniSat: window.unisat.signMessage(msg, 'bip322-simple')).
//
// Flow: POST /api/challenge -> server stores {nonce, address, action, id, price,
// expiry} and returns the exact text to sign. The client signs it and sends
// the nonce + signature with the mutation. The server re-reads the stored
// challenge (never the client's copy of the message), verifies the signature
// against the stored address, and burns the nonce.
import crypto from 'node:crypto';
import { Verifier } from 'bip322-js';

export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; this.status = 401; }
}

export function buildChallengeMessage({ action, address, inscriptionId, priceSats, nonce, expiresAt }) {
  const lines = [
    'Degent Marketplace',
    `action: ${action}`,
    `inscription: ${inscriptionId}`,
  ];
  if (priceSats !== undefined && priceSats !== null) lines.push(`price: ${priceSats} sats`);
  lines.push(`address: ${address}`, `nonce: ${nonce}`, `expires: ${expiresAt}`);
  return lines.join('\n');
}

export function createAuth({ stmts, ttlSec = 600, now = () => Date.now() }) {
  function issueChallenge({ action, address, inscriptionId, priceSats }) {
    if (action === 'list' && (priceSats === undefined || priceSats === null)) {
      throw new AuthError('priceSats is required for a list challenge');
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(now() + ttlSec * 1000).toISOString();
    const price = action === 'list' ? priceSats : null;
    const message = buildChallengeMessage({ action, address, inscriptionId, priceSats: price, nonce, expiresAt });
    stmts.insertChallenge.run({ nonce, address, action, inscription_id: inscriptionId, price_sats: price, message, expires_at: expiresAt });
    return { nonce, message, expiresAt };
  }

  /**
   * Verify and consume. Every stored field must match what the mutation claims,
   * so a "list" challenge for one price can't authorise a listing at another.
   */
  function verify({ nonce, signature, action, address, inscriptionId, priceSats }) {
    const row = stmts.getChallenge.get(nonce);
    if (!row) throw new AuthError('Unknown challenge');
    if (row.used) throw new AuthError('Challenge already used');
    if (new Date(row.expires_at).getTime() < now()) throw new AuthError('Challenge expired');
    if (row.action !== action) throw new AuthError('Challenge action mismatch');
    if (row.address !== address) throw new AuthError('Challenge address mismatch');
    if (row.inscription_id !== inscriptionId) throw new AuthError('Challenge inscription mismatch');
    if (action === 'list' && Number(row.price_sats) !== Number(priceSats)) throw new AuthError('Challenge price mismatch');

    let ok = false;
    try {
      ok = Verifier.verifySignature(address, row.message, signature);
    } catch (err) {
      throw new AuthError(`Signature could not be verified: ${err.message}`);
    }
    if (!ok) throw new AuthError('Invalid signature for this address');
    const burned = stmts.useChallenge.run(nonce);
    if (burned.changes !== 1) throw new AuthError('Challenge already used');
    return true;
  }

  function purge() {
    stmts.purgeChallenges.run(new Date(now()).toISOString());
  }

  return { issueChallenge, verify, purge };
}
