/** Sign in with Bitcoin round trips using @bsh/identity's own signing helpers, and session handling. */
import { describe, expect, it } from 'vitest';
import { InMemoryNonceStore, createChallenge, signBip322Simple } from '@bsh/identity';
import { addr, api, key, makeHarness, signIn, wallet, DOMAIN, NET } from './fakes/harness.js';

describe('POST /v1/auth/challenge', () => {
  it('issues a canonical SIWB message bound to the studio domain and the address', async () => {
    const h = makeHarness();
    const w = wallet(1);
    const r = await api(h, 'POST', '/v1/auth/challenge', { json: { address: w.address, network: NET } });
    expect(r.status).toBe(201);
    expect(r.body.message.split('\n')[0]).toBe(`${DOMAIN} wants you to sign in with your Bitcoin account:`);
    expect(r.body.message.split('\n')[1]).toBe(w.address);
    expect(r.body.message).toContain(`URI: http://${DOMAIN}`);
    expect(r.body.message).toContain(`Nonce: ${r.body.nonce}`);
    expect(r.body.issuedAt).toBe('2026-09-24T12:00:00.000Z');
    expect(r.body.expiresAt).toBe('2026-09-24T12:05:00.000Z');
    expect(r.body.network).toBe(NET);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('nonces differ per challenge', async () => {
    const h = makeHarness();
    const w = wallet(1);
    const a = await api(h, 'POST', '/v1/auth/challenge', { json: { address: w.address, network: NET } });
    const b = await api(h, 'POST', '/v1/auth/challenge', { json: { address: w.address, network: NET } });
    expect(a.body.nonce).not.toBe(b.body.nonce);
  });

  it('refuses another network (network_mismatch) and invalid / foreign addresses', async () => {
    const h = makeHarness();
    const r = await api(h, 'POST', '/v1/auth/challenge', { json: { address: wallet(1).address, network: 'mainnet' } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('network_mismatch');
    const bad = await api(h, 'POST', '/v1/auth/challenge', { json: { address: 'bcrt1qnotanaddress', network: NET } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    const foreign = await api(h, 'POST', '/v1/auth/challenge', { json: { address: addr('tr', key(1), 'mainnet'), network: NET } });
    expect(foreign.status).toBe(422);
    const missing = await api(h, 'POST', '/v1/auth/challenge', { json: { network: NET } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.message).toContain('address');
  });

  it('rejects non-JSON bodies and bad JSON', async () => {
    const h = makeHarness();
    expect((await api(h, 'POST', '/v1/auth/challenge', { headers: { 'content-type': 'text/plain' }, json: {} })).status).toBe(415);
    const r = await h.app.request('/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('bad_request');
  });
});

describe('POST /v1/auth/verify', () => {
  it.each([
    ['taproot, BIP-322 simple', 'tr'],
    ['segwit, BIP-322 simple', 'wpkh'],
    ['legacy P2PKH, signmessage', 'pkh'],
  ] as const)('signs in a %s wallet and creates the artist on first sign-in', async (_n, kind) => {
    const h = makeHarness();
    const w = wallet(5, kind);
    const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address: w.address, network: NET } });
    const v = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: w.sign(ch.body.message), address: w.address } });
    expect(v.status).toBe(200);
    expect(v.body.method).toBe(kind === 'pkh' ? 'legacy' : 'bip322-simple');
    expect(v.body.artist).toMatchObject({ address: w.address, network: NET, displayName: null, payoutAddress: null, joinedAt: '2026-09-24T12:00:00.000Z', artworks: { total: 0, approved: 0 } });
    expect(v.body.expiresAt).toBe('2026-09-24T13:00:00.000Z');
    expect(v.body.token.split('.')).toHaveLength(3);
    const claims = h.keys.verify(v.body.token, { issuer: 'degent-studio', audience: 'degent', now: h.clock.now() });
    expect(claims).toMatchObject({ sub: w.address, product: 'degent', scopes: ['artist'], accounts: [w.address] });
  });

  it('a second sign-in keeps the same artist (joinedAt unchanged)', async () => {
    const h = makeHarness();
    const a = await signIn(h, 6);
    h.clock.advance(3600);
    const b = await signIn(h, 6);
    expect(a.token).not.toBe(b.token);
    expect((await api(h, 'GET', '/v1/artists/me', { token: b.token })).body.joinedAt).toBe('2026-09-24T12:00:00.000Z');
  });

  it('refuses a replayed challenge (nonce consumed)', async () => {
    const h = makeHarness();
    const w = wallet(7);
    const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address: w.address, network: NET } });
    const sig = w.sign(ch.body.message);
    expect((await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: sig, address: w.address } })).status).toBe(200);
    const again = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: sig, address: w.address } });
    expect(again.status).toBe(401);
    expect(again.body.error).toMatchObject({ code: 'sign_in_failed', details: { reason: 'nonce_replayed' } });
  });

  it('refuses a challenge we did not issue, a wrong signer, a tampered message and an expired challenge', async () => {
    const h = makeHarness();
    const w = wallet(8);
    const other = wallet(9);
    // Not issued by this server (valid grammar, unknown nonce).
    const foreign = createChallenge({ domain: DOMAIN, uri: `http://${DOMAIN}`, address: w.address, network: NET, ttlSeconds: 300, now: h.clock.now() });
    const f = await api(h, 'POST', '/v1/auth/verify', { json: { message: foreign.message, signature: w.sign(foreign.message), address: w.address } });
    expect(f.status).toBe(401);
    expect(f.body.error.details.reason).toBe('nonce_unknown');

    const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address: w.address, network: NET } });
    const wrongSigner = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: other.sign(ch.body.message), address: w.address } });
    expect(wrongSigner.body.error.details.reason).toBe('invalid_signature');
    const mismatch = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: w.sign(ch.body.message), address: other.address } });
    expect(mismatch.body.error.details.reason).toBe('address_mismatch');
    const tampered = ch.body.message.replace('Version: 1', 'Version: 2');
    expect((await api(h, 'POST', '/v1/auth/verify', { json: { message: tampered, signature: w.sign(tampered), address: w.address } })).body.error.details.reason).toBe('malformed_message');
    h.clock.advance(301);
    const late = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: w.sign(ch.body.message), address: w.address } });
    expect(late.body.error.details.reason).toBe('expired');
  });

  it('refuses a challenge for another domain even with a valid signature', async () => {
    const h = makeHarness();
    const w = wallet(10);
    const ch = createChallenge({ domain: 'evil.example', address: w.address, network: NET, ttlSeconds: 300, now: h.clock.now() });
    await h.nonces.issue({ nonce: ch.fields.nonce, expiresAt: Date.parse(ch.fields.expirationTime), domain: 'evil.example', address: w.address });
    const r = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.message, signature: w.sign(ch.message), address: w.address } });
    expect(r.status).toBe(401);
    expect(r.body.error.details.reason).toBe('domain_mismatch');
  });

  it('validates the request shape', async () => {
    const h = makeHarness();
    expect((await api(h, 'POST', '/v1/auth/verify', { json: { signature: 'x', address: wallet(1).address } })).status).toBe(422);
    expect((await api(h, 'POST', '/v1/auth/verify', { json: { message: 'x', address: wallet(1).address } })).status).toBe(422);
    expect((await api(h, 'POST', '/v1/auth/verify', { json: { message: 'x'.repeat(5000), signature: 'y', address: wallet(1).address } })).status).toBe(422);
    expect((await api(h, 'POST', '/v1/auth/verify', { json: [] })).status).toBe(422);
  });

  it('does not accept a BIP-322 signature for a different message than the challenge', async () => {
    const h = makeHarness();
    const w = wallet(12);
    const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address: w.address, network: NET } });
    const sig = signBip322Simple(w.priv, 'p2tr', 'Hello World');
    const r = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: sig, address: w.address } });
    expect(r.status).toBe(401);
    expect(r.body.error.details.reason).toBe('invalid_signature');
    void InMemoryNonceStore;
  });
});

describe('sessions', () => {
  it('missing, malformed, foreign and expired tokens are 401 with a reason', async () => {
    const h = makeHarness();
    expect((await api(h, 'GET', '/v1/artists/me')).status).toBe(401);
    expect((await api(h, 'GET', '/v1/artists/me', { headers: { authorization: 'Basic abc' } })).status).toBe(401);
    const bad = await api(h, 'GET', '/v1/artists/me', { token: 'a.b.c' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.details.reason).toBe('malformed');
    const s = await signIn(h, 13);
    const forged = `${s.token.slice(0, -4)}AAAA`;
    expect((await api(h, 'GET', '/v1/artists/me', { token: forged })).body.error.details.reason).toBe('bad_signature');
    h.clock.advance(3600 + 31);
    const expired = await api(h, 'GET', '/v1/artists/me', { token: s.token });
    expect(expired.status).toBe(401);
    expect(expired.body.error.details.reason).toBe('expired');
  });

  it('a session for another product / issuer / scope is refused', async () => {
    const h = makeHarness();
    const w = wallet(14);
    await signIn(h, w);
    const otherProduct = h.keys.issue({ sub: w.address, accounts: [w.address], product: 'blockspace', scopes: ['artist'] }, { issuer: 'degent-studio', now: h.clock.now() });
    expect((await api(h, 'GET', '/v1/artists/me', { token: otherProduct })).body.error.details.reason).toBe('wrong_audience');
    const otherIssuer = h.keys.issue({ sub: w.address, accounts: [w.address], product: 'degent', scopes: ['artist'] }, { issuer: 'blockspace-id', now: h.clock.now() });
    expect((await api(h, 'GET', '/v1/artists/me', { token: otherIssuer })).body.error.details.reason).toBe('wrong_issuer');
    const noScope = h.keys.issue({ sub: w.address, accounts: [w.address], product: 'degent', scopes: ['viewer'] }, { issuer: 'degent-studio', now: h.clock.now() });
    expect((await api(h, 'GET', '/v1/artists/me', { token: noScope })).body.error.details.reason).toBe('insufficient_scope');
  });

  it('a valid session for an address that never signed in is refused', async () => {
    const h = makeHarness();
    const w = wallet(15);
    const t = h.keys.issue({ sub: w.address, accounts: [w.address], product: 'degent', scopes: ['artist'] }, { issuer: 'degent-studio', now: h.clock.now() });
    const r = await api(h, 'GET', '/v1/artists/me', { token: t });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toContain('sign in again');
  });

  it('an API key is not an artist session', async () => {
    const h = makeHarness();
    const r = await api(h, 'GET', '/v1/artists/me', { token: h.reviewerKey });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toContain('API key');
  });
});
