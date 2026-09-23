import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { InMemoryAttestationSigner, keyIdOf } from '../src/adapters/memory-signer.js';
import { attestationDigest, signAttestation, verifyAttestation } from '../src/domain/attestation.js';
import { bytesToHex } from '../src/domain/hash.js';
import type { Attestation, UnsignedAttestation } from '../src/domain/model.js';

const SECRET = '0f'.repeat(32);
const signer = InMemoryAttestationSigner.fromHex(SECRET);
const pub = bytesToHex(signer.publicKey);

const body: Omit<UnsignedAttestation, 'keyId'> = {
  collection: { slug: 'degent', name: 'Decentralized Gentlemen Club', parentInscriptionId: `${'ab'.repeat(32)}i0` },
  method: 'parent-children+manifest',
  sources: [
    { type: 'parent-children', parentInscriptionId: `${'ab'.repeat(32)}i0`, pages: 3, listed: 5, accepted: 4, excluded: 1 },
    { type: 'manifest', manifestInscriptionId: null, manifestSha256: 'cd'.repeat(32), verified: false, listed: 4112, accepted: 0, excluded: 0 },
  ],
  stats: {
    itemCount: 4,
    excludedCount: 1,
    totalContentBytes: 1000,
    minItemBytes: 100,
    maxItemBytes: 400,
    medianItemBytes: 250,
    firstInscriptionNumber: 10,
    lastInscriptionNumber: 13,
    totalRevealVbytes: 1234,
    revealTxCount: 4,
    itemsDigest: 'ef'.repeat(32),
  },
  asOfBlockHeight: 915_012,
  issuedAt: '2026-09-23T12:00:00.000Z',
};

describe('attestation signing', () => {
  it('signs and verifies; keyId is the first 8 bytes of sha256(pubkey)', async () => {
    const { attestation, digest } = await signAttestation(body, signer);
    expect(attestation.keyId).toBe(createHash('sha256').update(signer.publicKey).digest('hex').slice(0, 16));
    expect(attestation.keyId).toBe(keyIdOf(signer.publicKey));
    expect(attestation.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(digest).toBe(bytesToHex(attestationDigest(attestation)));
    expect(verifyAttestation(attestation, pub)).toEqual({ ok: true });
  });

  it('digest follows the published recipe (independent implementation)', async () => {
    const { attestation, digest } = await signAttestation(body, signer);
    const { signature: _s, ...unsigned } = attestation;
    const canonical = (v: unknown): string =>
      Array.isArray(v)
        ? `[${v.map(canonical).join(',')}]`
        : v && typeof v === 'object'
          ? `{${Object.keys(v)
              .sort()
              .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
              .join(',')}}`
          : JSON.stringify(v);
    const tag = createHash('sha256').update('block.space/collection-attestation/v1').digest();
    const expected = createHash('sha256').update(tag).update(tag).update(canonical(unsigned)).digest('hex');
    expect(digest).toBe(expected);
    // and it is a plain BIP340 signature over that digest
    expect(schnorr.verify(Buffer.from(attestation.signature, 'hex'), Buffer.from(expected, 'hex'), signer.publicKey)).toBe(true);
  });

  it('is deterministic for the same input (BIP340 with a fixed key and no aux randomness)', async () => {
    const a = await signAttestation(body, signer);
    const b = await signAttestation(structuredClone(body), signer);
    expect(a.digest).toBe(b.digest);
    // key order of the input does not matter
    const reordered = { stats: body.stats, issuedAt: body.issuedAt, asOfBlockHeight: body.asOfBlockHeight, sources: body.sources, method: body.method, collection: body.collection };
    expect((await signAttestation(reordered, signer)).digest).toBe(a.digest);
  });

  describe('tamper detection', () => {
    const mutations: [string, (a: Attestation) => void][] = [
      ['itemCount', (a) => (a.stats.itemCount += 1)],
      ['totalContentBytes', (a) => (a.stats.totalContentBytes -= 1)],
      ['medianItemBytes', (a) => (a.stats.medianItemBytes = 250.5)],
      ['itemsDigest', (a) => (a.stats.itemsDigest = '00'.repeat(32))],
      ['totalRevealVbytes → null', (a) => (a.stats.totalRevealVbytes = null)],
      ['asOfBlockHeight', (a) => (a.asOfBlockHeight += 1)],
      ['issuedAt', (a) => (a.issuedAt = '2026-09-23T12:00:00.001Z')],
      ['method', (a) => (a.method = 'parent-children')],
      ['manifest verified flag', (a) => ((a.sources[1] as { verified: boolean }).verified = true)],
      ['source dropped', (a) => a.sources.pop()],
      ['collection slug', (a) => (a.collection.slug = 'degent2')],
      ['keyId', (a) => (a.keyId = '0'.repeat(16))],
      ['extra field', (a) => ((a as unknown as Record<string, unknown>).badge = 'gold')],
    ];
    for (const [name, mutate] of mutations)
      it(`rejects a changed ${name}`, async () => {
        const { attestation } = await signAttestation(body, signer);
        const t = structuredClone(attestation);
        mutate(t);
        expect(verifyAttestation(t, pub)).toEqual({ ok: false, reason: 'bad_signature' });
      });

    it('rejects a flipped signature bit, a wrong key and malformed input', async () => {
      const { attestation } = await signAttestation(body, signer);
      const flipped = { ...attestation, signature: (attestation.signature[0] === '0' ? '1' : '0') + attestation.signature.slice(1) };
      expect(verifyAttestation(flipped, pub).ok).toBe(false);
      const other = InMemoryAttestationSigner.fromHex('1e'.repeat(32));
      expect(verifyAttestation(attestation, bytesToHex(other.publicKey))).toEqual({ ok: false, reason: 'bad_signature' });
      expect(verifyAttestation({ ...attestation, signature: 'zz' }, pub)).toEqual({ ok: false, reason: 'malformed' });
      expect(verifyAttestation(attestation, 'not-hex')).toEqual({ ok: false, reason: 'malformed' });
    });
  });

  it('signer rejects bad keys and non-32-byte digests', async () => {
    expect(() => InMemoryAttestationSigner.fromHex('00')).toThrow();
    await expect(signer.sign(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });
});
