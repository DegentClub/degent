/** Artist profile: display name, BIP-322-proven payout address (positive and negative), public profile. */
import { describe, expect, it } from 'vitest';
import { signBip322Simple, signLegacyMessage } from '@bsh/identity';
import { payoutMessage, PAYOUT_MESSAGE_TEMPLATE } from '../src/domain/artist.js';
import { addr, api, key, makeHarness, payoutProof, signIn, submit, wallet } from './fakes/harness.js';

describe('GET / PUT /v1/artists/me', () => {
  it('returns the private profile with artwork counts', async () => {
    const h = makeHarness();
    const s = await signIn(h, 1);
    await submit(h, s);
    await submit(h, s, { bytes: new Uint8Array(200_000) }).catch(() => {}); // rejected by rules (not an image)
    const r = await api(h, 'GET', '/v1/artists/me', { token: s.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ address: s.address, displayName: null, payoutAddress: null, payoutVerifiedAt: null, artworks: { total: 2, approved: 1 } });
  });

  it('sets, trims and clears the display name (<= 40 chars)', async () => {
    const h = makeHarness();
    const s = await signIn(h, 2);
    const ok = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: '  Sir   Pepe  ' } });
    expect(ok.status).toBe(200);
    expect(ok.body.displayName).toBe('Sir Pepe');
    expect(ok.body.updatedAt).toBe('2026-09-24T12:00:00.000Z');
    const long = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: 'x'.repeat(41) } });
    expect(long.status).toBe(422);
    expect(long.body.error.message).toContain('40');
    expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: 'x'.repeat(40) } })).status).toBe(200);
    expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: 'bad\u0000name' } })).status).toBe(422);
    expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: 42 } })).status).toBe(422);
    const cleared = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: null } });
    expect(cleared.body.displayName).toBeNull();
    const empty = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: '   ' } });
    expect(empty.body.displayName).toBeNull();
  });

  it('refuses an empty update and unknown fields', async () => {
    const h = makeHarness();
    const s = await signIn(h, 3);
    expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: {} })).status).toBe(422);
    expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { address: 'x' } })).status).toBe(422);
    expect((await api(h, 'PUT', '/v1/artists/me', { json: { displayName: 'x' } })).status).toBe(401);
  });

  it('the payout message template is fixed', () => {
    expect(PAYOUT_MESSAGE_TEMPLATE).toBe('degent.club payout address <address> for <sessionSub>');
    expect(payoutMessage('bc1pxyz', 'bc1qabc')).toBe('degent.club payout address bc1pxyz for bc1qabc');
  });

  describe('payout address proof (BIP-322 simple)', () => {
    it.each([
      ['taproot payout', 'tr'],
      ['segwit payout', 'wpkh'],
    ] as const)('accepts a %s address proven by its own key, distinct from the sign-in address', async (_n, kind) => {
      const h = makeHarness();
      const s = await signIn(h, 4);
      const payout = wallet(40, kind);
      const r = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: payoutProof(payout, s.address) } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.payoutAddress).toBe(payout.address);
      expect(r.body.payoutVerifiedAt).toBe('2026-09-24T12:00:00.000Z');
      expect((await api(h, 'GET', '/v1/artists/me', { token: s.token })).body.payoutAddress).toBe(payout.address);
    });

    it('the sign-in wallet can also be the payout wallet', async () => {
      const h = makeHarness();
      const s = await signIn(h, 5);
      const r = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: payoutProof(s.wallet, s.address) } });
      expect(r.status).toBe(200);
      expect(r.body.payoutAddress).toBe(s.address);
    });

    it('accepts a 65-byte SIGHASH_ALL taproot signature too', async () => {
      const h = makeHarness();
      const s = await signIn(h, 6);
      const payout = wallet(60);
      const signature = signBip322Simple(payout.priv, 'p2tr', payoutMessage(payout.address, s.address), { hashType: 0x01 });
      expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: { address: payout.address, signature } } })).status).toBe(200);
    });

    it('refuses legacy P2PKH and P2SH payout addresses with a clear error, even with a valid legacy signature', async () => {
      const h = makeHarness();
      const s = await signIn(h, 7);
      const legacy = wallet(70, 'pkh');
      const signature = signLegacyMessage(legacy.priv, payoutMessage(legacy.address, s.address), 'p2pkh');
      const r = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: { address: legacy.address, signature } } });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('payout_address_legacy');
      expect(r.body.error.message).toContain('segwit');
      expect(r.body.error.details).toEqual({ kind: 'p2pkh', accepted: ['p2wpkh', 'p2tr'] });
      // P2SH (regtest prefix 0xc4 -> "2...")
      const p2sh = '2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br';
      const r2 = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: { address: p2sh, signature } } });
      expect(r2.status).toBe(422);
      expect(r2.body.error.code).toBe('payout_address_legacy');
      expect(r2.body.error.details.kind).toBe('p2sh');
    });

    it('refuses a proof signed by another key, over another message or for another session', async () => {
      const h = makeHarness();
      const s = await signIn(h, 8);
      const payout = wallet(80);
      const impostor = wallet(81);
      const message = payoutMessage(payout.address, s.address);
      const cases = [
        ['another key', signBip322Simple(impostor.priv, 'p2tr', message)],
        ['another message', signBip322Simple(payout.priv, 'p2tr', 'degent.club payout address for someone else')],
        ['another session subject', signBip322Simple(payout.priv, 'p2tr', payoutMessage(payout.address, impostor.address))],
        ['a legacy signature for a taproot address', signLegacyMessage(payout.priv, message, 'p2wpkh')],
        ['garbage', 'not-base64!!'],
      ];
      for (const [name, signature] of cases) {
        const r = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: { address: payout.address, signature } } });
        expect(r.status, name).toBe(422);
        expect(r.body.error.code, name).toBe('payout_proof_invalid');
        expect(r.body.error.details.message).toBe(message);
      }
      expect((await api(h, 'GET', '/v1/artists/me', { token: s.token })).body.payoutAddress).toBeNull();
    });

    it('refuses addresses of another network, malformed addresses and missing signatures', async () => {
      const h = makeHarness();
      const s = await signIn(h, 9);
      const mainnet = addr('tr', key(90), 'mainnet');
      const r = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: { address: mainnet, signature: signBip322Simple(key(90), 'p2tr', payoutMessage(mainnet, s.address)) } } });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('validation_failed');
      expect(r.body.error.message).toContain('regtest');
      expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: { address: 'bcrt1qxx', signature: 'AA==' } } })).status).toBe(422);
      expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: { address: wallet(91).address } } })).status).toBe(422);
      expect((await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { payout: 'x' } })).status).toBe(422);
    });

    it('an artist cannot set another artist\'s proven payout address (subject binding)', async () => {
      const h = makeHarness();
      const alice = await signIn(h, 10);
      const bob = await signIn(h, 11);
      const payout = wallet(100);
      const proofForAlice = payoutProof(payout, alice.address);
      expect((await api(h, 'PUT', '/v1/artists/me', { token: alice.token, json: { payout: proofForAlice } })).status).toBe(200);
      const stolen = await api(h, 'PUT', '/v1/artists/me', { token: bob.token, json: { payout: proofForAlice } });
      expect(stolen.status).toBe(422);
      expect(stolen.body.error.code).toBe('payout_proof_invalid');
    });

    it('displayName and payout can be updated together', async () => {
      const h = makeHarness();
      const s = await signIn(h, 12);
      const r = await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: 'Both', payout: payoutProof(wallet(120, 'wpkh'), s.address) } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ displayName: 'Both', payoutAddress: wallet(120, 'wpkh').address });
    });
  });
});

describe('GET /v1/artists/{address}', () => {
  it('shows only public fields and the approved count', async () => {
    const h = makeHarness();
    const s = await signIn(h, 13);
    await api(h, 'PUT', '/v1/artists/me', { token: s.token, json: { displayName: 'Public Pepe', payout: payoutProof(wallet(130), s.address) } });
    const a = await submit(h, s);
    await submit(h, s);
    await api(h, 'DELETE', `/v1/artworks/${a.artworkId}`, { token: s.token });
    const r = await api(h, 'GET', `/v1/artists/${s.address}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ address: s.address, displayName: 'Public Pepe', artworks: 1, joinedAt: '2026-09-24T12:00:00.000Z' });
    expect(JSON.stringify(r.body)).not.toContain(wallet(130).address);
  });

  it('404 for unknown artists', async () => {
    const h = makeHarness();
    const r = await api(h, 'GET', `/v1/artists/${wallet(99).address}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
});
