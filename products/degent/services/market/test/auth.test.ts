/**
 * BIP-322 ownership proofs via @bsh/identity (the legacy suite used bip322-js fixtures): the platform
 * signer produces the fixture, `verifyBip322Simple` checks it, and MarketAuth binds SIWB challenges to
 * marketplace actions (single use, expiring, action/inscription/price bound).
 */
import { describe, expect, it } from 'vitest';
import { InMemoryNonceStore, parseSiwbMessage, signBip322Simple, verifyBip322Simple } from '@bsh/identity';
import { MarketAuth, requestIdFor } from '../src/application/auth.js';
import { FakeClock } from './fakes/harness.js';
import { INSCRIPTION_ID, NET, keyFromSeed } from './fakes/keys.js';

const seller = keyFromSeed('seller');
const log = { info: () => {}, warn: () => {}, error: () => {} };

function makeAuth(ttlSeconds = 600) {
  const clock = new FakeClock();
  const auth = new MarketAuth({ nonces: new InMemoryNonceStore(), clock, network: NET, domain: 'market.degent.test', uri: null, ttlSeconds, log });
  return { auth, clock };
}
const list = { action: 'list' as const, address: seller.tr.address, inscriptionId: INSCRIPTION_ID, priceSats: 50_000 };

describe('BIP-322 fixtures via @bsh/identity', () => {
  it('a taproot signature from the platform signer verifies (known-good fixture), a tampered message does not', () => {
    const msg = 'degent market fixture';
    const sig = signBip322Simple(seller.priv, 'p2tr', msg, { auxRand: new Uint8Array(32) });
    expect(signBip322Simple(seller.priv, 'p2tr', msg, { auxRand: new Uint8Array(32) })).toBe(sig); // deterministic fixture
    expect(verifyBip322Simple(seller.tr.address, NET, msg, sig)).toEqual({ valid: true, kind: 'p2tr' });
    expect(verifyBip322Simple(seller.tr.address, NET, `${msg}!`, sig).valid).toBe(false);
    expect(verifyBip322Simple(keyFromSeed('other').tr.address, NET, msg, sig).valid).toBe(false);
  });

  it('a native segwit (P2WPKH) signature verifies too', () => {
    const sig = signBip322Simple(seller.priv, 'p2wpkh', 'hello');
    expect(verifyBip322Simple(seller.wpkh.address, NET, 'hello', sig)).toEqual({ valid: true, kind: 'p2wpkh' });
  });
});

describe('MarketAuth (SIWB bound to the action)', () => {
  it('the challenge is canonical SIWB with a Request ID binding action, inscription and price', async () => {
    const { auth } = makeAuth();
    const { message, expiresAt } = await auth.challenge(list);
    const f = parseSiwbMessage(message);
    expect(f.requestId).toBe(`list:${INSCRIPTION_ID}:50000`);
    expect(f.address).toBe(seller.tr.address);
    expect(f.statement).toContain('50000 sats');
    expect(expiresAt).toBe(f.expirationTime);
    expect(requestIdFor({ action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID })).toBe(`cancel:${INSCRIPTION_ID}`);
  });

  it('verifies once and burns the nonce', async () => {
    const { auth } = makeAuth();
    const { message } = await auth.challenge(list);
    const signature = signBip322Simple(seller.priv, 'p2tr', message);
    await expect(auth.verify(list, { message, signature })).resolves.toBeUndefined();
    await expect(auth.verify(list, { message, signature })).rejects.toMatchObject({ code: 'auth_failed', status: 401 });
  });

  it('rejects another key, a tampered message and mismatched claims (price, inscription, action, address)', async () => {
    const { auth } = makeAuth();
    const { message } = await auth.challenge(list);
    const good = signBip322Simple(seller.priv, 'p2tr', message);
    await expect(auth.verify(list, { message, signature: signBip322Simple(keyFromSeed('x').priv, 'p2tr', message) })).rejects.toMatchObject({ code: 'auth_failed' });
    await expect(auth.verify(list, { message: message.replace('50000 sats', '50001 sats'), signature: good })).rejects.toMatchObject({ code: 'auth_failed' });
    await expect(auth.verify({ ...list, priceSats: 1 }, { message, signature: good })).rejects.toMatchObject({ code: 'auth_failed' });
    await expect(auth.verify({ ...list, inscriptionId: `${'0'.repeat(64)}i0` }, { message, signature: good })).rejects.toMatchObject({ code: 'auth_failed' });
    await expect(auth.verify({ action: 'cancel', address: seller.tr.address, inscriptionId: INSCRIPTION_ID }, { message, signature: good })).rejects.toMatchObject({ code: 'auth_failed' });
    await expect(auth.verify({ ...list, address: keyFromSeed('x').tr.address }, { message, signature: good })).rejects.toMatchObject({ code: 'auth_failed' });
    // none of the mismatches burned the nonce: the right claim still verifies
    await expect(auth.verify(list, { message, signature: good })).resolves.toBeUndefined();
  });

  it('expires challenges', async () => {
    const { auth, clock } = makeAuth(60);
    const { message } = await auth.challenge(list);
    clock.advance(61_000);
    await expect(auth.verify(list, { message, signature: signBip322Simple(seller.priv, 'p2tr', message) })).rejects.toMatchObject({ code: 'auth_failed' });
  });

  it('refuses a message that is not canonical SIWB, and messages from another domain', async () => {
    const { auth } = makeAuth();
    await expect(auth.verify(list, { message: 'Degent Marketplace\naction: list', signature: 'AA==' })).rejects.toMatchObject({ code: 'auth_failed' });
    const other = new MarketAuth({ nonces: new InMemoryNonceStore(), clock: new FakeClock(), network: NET, domain: 'evil.example', uri: null, ttlSeconds: 600, log });
    const { message } = await other.challenge(list);
    await expect(auth.verify(list, { message, signature: signBip322Simple(seller.priv, 'p2tr', message) })).rejects.toMatchObject({ code: 'auth_failed' });
  });
});
