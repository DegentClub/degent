import { describe, it, expect } from 'vitest';
import { Signer, Verifier } from 'bip322-js';
import { openDb, prepareStatements } from '../src/db.js';
import { createAuth, AuthError, buildChallengeMessage } from '../src/auth.js';
import { keyFromSeed, INSCRIPTION_ID } from './helpers.js';

const seller = keyFromSeed('seller');
const other = keyFromSeed('other');

function setup(now = () => Date.now()) {
  const db = openDb(':memory:');
  const stmts = prepareStatements(db);
  return { auth: createAuth({ stmts, ttlSec: 60, now }), stmts };
}

describe('BIP-322 challenge auth', () => {
  it('verifies a taproot signature produced by bip322-js Signer (known-good fixture)', () => {
    const { auth } = setup();
    const ch = auth.issueChallenge({ action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 5000 });
    expect(ch.message).toContain('action: list');
    expect(ch.message).toContain('price: 5000 sats');
    expect(ch.message).toContain(`nonce: ${ch.nonce}`);
    const sig = Signer.sign(seller.wif, seller.tr.address, ch.message);
    expect(Verifier.verifySignature(seller.tr.address, ch.message, sig)).toBe(true);
    expect(auth.verify({ nonce: ch.nonce, signature: sig, action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 5000 })).toBe(true);
  });

  it('verifies a native segwit signature too', () => {
    const { auth } = setup();
    const ch = auth.issueChallenge({ action: 'cancel', address: seller.wpkh.address, inscriptionId: INSCRIPTION_ID });
    const sig = Signer.sign(seller.wif, seller.wpkh.address, ch.message);
    expect(auth.verify({ nonce: ch.nonce, signature: sig, action: 'cancel', address: seller.wpkh.address, inscriptionId: INSCRIPTION_ID })).toBe(true);
  });

  it('burns the nonce after one use', () => {
    const { auth } = setup();
    const ch = auth.issueChallenge({ action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID });
    const sig = Signer.sign(seller.wif, seller.tr.address, ch.message);
    const args = { nonce: ch.nonce, signature: sig, action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID };
    expect(auth.verify(args)).toBe(true);
    expect(() => auth.verify(args)).toThrow(/already used/);
  });

  it('rejects a signature from another key, a tampered message, or mismatched claims', () => {
    const { auth } = setup();
    const ch = auth.issueChallenge({ action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 5000 });
    const wrongKey = Signer.sign(other.wif, other.tr.address, ch.message);
    expect(() => auth.verify({ nonce: ch.nonce, signature: wrongKey, action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 5000 })).toThrow(AuthError);
    const forOtherMsg = Signer.sign(seller.wif, seller.tr.address, ch.message.replace('5000', '1000'));
    expect(() => auth.verify({ nonce: ch.nonce, signature: forOtherMsg, action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 5000 })).toThrow(/Invalid signature/);
    const good = Signer.sign(seller.wif, seller.tr.address, ch.message);
    expect(() => auth.verify({ nonce: ch.nonce, signature: good, action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 1000 })).toThrow(/price mismatch/);
    expect(() => auth.verify({ nonce: ch.nonce, signature: good, action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID })).toThrow(/action mismatch/);
    expect(() => auth.verify({ nonce: 'f'.repeat(32), signature: good, action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 5000 })).toThrow(/Unknown/);
    expect(() => auth.verify({ nonce: ch.nonce, signature: 'not-base64!!', action: 'list', address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 5000 })).toThrow(AuthError);
  });

  it('expires challenges', () => {
    let t = 1_000_000_000_000;
    const { auth } = setup(() => t);
    const ch = auth.issueChallenge({ action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID });
    const sig = Signer.sign(seller.wif, seller.tr.address, ch.message);
    t += 61_000;
    expect(() => auth.verify({ nonce: ch.nonce, signature: sig, action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID })).toThrow(/expired/);
  });

  it('message format is deterministic', () => {
    const m = buildChallengeMessage({ action: 'list', address: 'bc1p...', inscriptionId: INSCRIPTION_ID, priceSats: 1, nonce: 'n', expiresAt: 'e' });
    expect(m.split('\n')).toEqual(['Degent Marketplace', 'action: list', `inscription: ${INSCRIPTION_ID}`, 'price: 1 sats', 'address: bc1p...', 'nonce: n', 'expires: e']);
  });
});
