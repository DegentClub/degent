/**
 * Launch chain setup (docs/LAUNCH-CHAIN-SETUP.md): prepare-parent / prepare-gallery are pure and deterministic,
 * the Gallery is the 4,112 roster members ordered by n with unique ids, sizes stay within limits, and a signed
 * Gallery verifies with the same BIP-322 verifier the member votes use.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signBip322Simple } from '@bsh/identity';
import { InMemoryPolicySigner } from '../src/adapters/in-memory-policy-signer.js';
import {
  GALLERY_SIZE,
  MAX_CHARTER_BYTES,
  MAX_GALLERY_BYTES,
  buildGallery,
  decodeCbor,
  encodeCbor,
  galleryBytes,
  prepareGallery,
  prepareParent,
  sha256Hex,
} from '../scripts/lib/chain-prep.mjs';
import { writeOut } from '../scripts/lib/write-out.mjs';
import { collectionAddressFromKeyHex, verifyGalleryDir } from '../scripts/chain-setup.js';
import { regtestAddress, regtestKey } from './fakes/harness.js';

const svc = new URL('..', import.meta.url).pathname;
const roster = JSON.parse(readFileSync(join(svc, 'data/roster.json'), 'utf8'));
const PARENT = `${'ab'.repeat(32)}i0`;
const tmp = () => mkdtempSync(join(tmpdir(), 'degent-chain-'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('CBOR (ord --cbor-metadata files)', () => {
  it('encodes canonical vectors and round-trips', () => {
    expect(hex(encodeCbor({ a: 1 }))).toBe('a1616101');
    expect(hex(encodeCbor([0, 23, 24, 255, 256, 65_536, -1, -25]))).toBe('880017181818ff1901001a00010000203818');
    expect(hex(encodeCbor({ t: true, f: false, z: null }))).toBe('a36174f56166f4617af6');
    expect(hex(encodeCbor(new Uint8Array([1, 2])))).toBe('420102');
    const v = { name: 'Decentralized Gentlemen Club', charter: '10000', n: 4112, big: 2 ** 40, list: ['x', new Uint8Array([9])] };
    expect(decodeCbor(encodeCbor(v))).toEqual(v);
    expect(() => decodeCbor(new Uint8Array([0xa1, 0x61]))).toThrow(/truncated/);
    expect(() => decodeCbor(new Uint8Array([0x01, 0x02]))).toThrow(/trailing/);
  });
});

describe('prepare-parent', () => {
  const opts = { network: 'signet', feeRate: 3, collectionAddress: 'tb1pcollection', destination: 'tb1pordwallet' };

  it('is deterministic and within limits; the charter is small and link-free', () => {
    const a = prepareParent(opts);
    const b = prepareParent(opts);
    expect(a.plan).toEqual(b.plan);
    for (const k of Object.keys(a.files)) expect(hex(a.files[k]!)).toBe(hex(b.files[k]!));
    const html = Buffer.from(a.files['charter.html']!).toString('utf8');
    expect(html.length).toBeLessThan(MAX_CHARTER_BYTES);
    expect(html).toContain('Decentralized Gentlemen Club');
    expect(html).not.toMatch(/https?:|href|src=|<script|<link|url\(/i);
    expect(decodeCbor(a.files['parent.metadata.cbor']!)).toEqual({ name: 'Decentralized Gentlemen Club', charter: '10000' });
    expect(a.plan.limits.every((l) => l.ok)).toBe(true);
  });

  it('prints the exact ord commands and the env to set afterwards', () => {
    const { plan } = prepareParent(opts);
    const step = (id: string) => plan.steps.find((s) => s.id === id)!;
    expect(step('parent.inscribe').run).toBe(
      'ord --chain signet wallet inscribe --fee-rate 3 --postage 10000sat --file charter.html --cbor-metadata parent.metadata.cbor --destination tb1pordwallet',
    );
    expect(step('parent.dry-run').run).toMatch(/--dry-run$/);
    expect(step('parent.handoff').run).toBe("ord --chain signet wallet send --fee-rate 3 tb1pcollection '<PARENT_INSCRIPTION_ID>'");
    expect(step('parent.handoff').after).toEqual(['gallery']);
    expect(plan.steps.map((s) => s.id)).toEqual(['parent.dry-run', 'parent.inscribe', 'gallery', 'parent.handoff', 'service.env']);
    expect(Object.keys(plan.env).sort()).toEqual(['COLLECTION_ADDRESS', 'PARENT_INSCRIPTION_ID', 'PARENT_OUTPOINT']);
    expect(step('parent.inscribe').verify![0]).toEqual({
      run: 'curl -s $ORD_URL/content/<PARENT_INSCRIPTION_ID> | sha256sum',
      expect: sha256Hex(prepareParent(opts).files['charter.html']!),
    });
  });

  it('refuses bad inputs', () => {
    expect(() => prepareParent({ ...opts, network: 'liquid' })).toThrow(/network/);
    expect(() => prepareParent({ ...opts, feeRate: 0 })).toThrow(/fee-rate/);
    expect(() => prepareParent({ ...opts, postage: 100 })).toThrow(/postage/);
    expect(() => prepareParent({ ...opts, charter: 10 })).toThrow(/charter/);
    expect(() => prepareParent({ ...opts, name: 'x'.repeat(3000) })).toThrow(/size limits/);
  });
});

describe('prepare-gallery', () => {
  const signer = regtestAddress(7);
  const base = { network: 'regtest', feeRate: 2, parent: PARENT, signingAddress: signer, roster, destination: 'bcrt1pordwallet' };

  it('builds 4,112 unique ids ordered by n, within the size limit, deterministically', () => {
    const g = buildGallery(roster);
    expect(g.version).toBe(1);
    expect(g.members).toHaveLength(GALLERY_SIZE);
    expect(g.members.map((m) => m.n)).toEqual(Array.from({ length: GALLERY_SIZE }, (_, i) => i + 1));
    expect(new Set(g.members.map((m) => m.id)).size).toBe(GALLERY_SIZE);
    expect(g.members[0]).toEqual({ n: 1, id: roster.members[0].inscriptionId });
    expect(Object.keys(g.members[0]!)).toEqual(['n', 'id']);
    const bytes = galleryBytes(g);
    expect(bytes.length).toBeLessThanOrEqual(MAX_GALLERY_BYTES);
    const a = prepareGallery(base);
    const b = prepareGallery(base);
    expect(a.plan).toEqual(b.plan);
    expect(a.plan.gallery!.sha256).toBe(sha256Hex(bytes));
    expect(a.plan.gallery!.bytes).toBe(bytes.length);
    // Pinned: the Gallery is forever. If data/roster.json changes, this hash (and the owner's signature) must too.
    expect(a.plan.gallery!.sha256).toBe('e9c7ef572ae90065b8a834c18861a7ecad742994ecff2b6693cf3b5a574b6696');
  });

  it('pass 1 emits the message to sign and no inscribe-ready metadata', () => {
    const { files, plan } = prepareGallery(base);
    expect(Object.keys(files).sort()).toEqual(['gallery.json', 'gallery.message.txt', 'gallery.sha256']);
    expect(Buffer.from(files['gallery.message.txt']!).toString()).toBe(
      `degent.club Gallery v1: 4112 members, sha256 ${plan.gallery!.sha256}, parent ${PARENT}`,
    );
    expect(plan.next).toBe('gallery.sign');
    expect(plan.steps.find((s) => s.id === 'gallery.inscribe')!.run).toBe(
      `ord --chain regtest wallet inscribe --fee-rate 2 --postage 10000sat --parent ${PARENT} --file gallery.json --cbor-metadata gallery.metadata.cbor --destination bcrt1pordwallet`,
    );
  });

  it('pass 2 with a real BIP-322 signature verifies; tampering is caught', () => {
    const message = prepareGallery(base).plan.gallery!.message;
    const signature = signBip322Simple(regtestKey(7), 'p2tr', message);
    const prepared = prepareGallery({ ...base, signature });
    expect(prepared.plan.next).toBe('gallery.verify-signature');
    const meta = decodeCbor(prepared.files['gallery.metadata.cbor']!) as Record<string, unknown>;
    expect(meta).toMatchObject({ kind: 'degent.club/gallery', version: 1, parent: PARENT, count: 4112, signer, signature, message });
    const dir = writeOut(tmp(), prepared);
    expect(readdirSync(dir).sort()).toEqual(['gallery.json', 'gallery.message.txt', 'gallery.metadata.cbor', 'gallery.metadata.json', 'gallery.sha256', 'plan.json']);
    expect(verifyGalleryDir(dir, 'regtest')).toMatchObject({ ok: true, count: 4112 });

    const forged = writeOut(tmp(), prepareGallery({ ...base, signature: signBip322Simple(regtestKey(8), 'p2tr', message) }));
    expect(verifyGalleryDir(forged, 'regtest').problems.join()).toMatch(/signature invalid/);
    writeFileSync(join(dir, 'gallery.json'), readFileSync(join(dir, 'gallery.json'), 'utf8').replace('"n":1,', '"n":1 ,'));
    expect(verifyGalleryDir(dir, 'regtest').problems.join()).toMatch(/sha256 differs/);
  });

  it('refuses gaps, duplicate numbers, duplicate ids and bad inputs', () => {
    const m = roster.members.slice(0, 3).map((x: { n: number; inscriptionId: string }) => ({ ...x }));
    expect(() => buildGallery({ members: [m[0], m[2]] }, 3)).toThrow(/missing #2/);
    expect(() => buildGallery({ members: [m[0], m[1], { ...m[2], n: 2 }] }, 3)).toThrow(/duplicate member number 2/);
    expect(() => buildGallery({ members: [m[0], m[1], { ...m[2], inscriptionId: m[0].inscriptionId }] }, 3)).toThrow(/duplicate inscription id/);
    expect(() => buildGallery({ members: [{ ...m[0], inscriptionId: 'nope' }] }, 1)).toThrow(/bad inscription id/);
    expect(() => prepareGallery({ ...base, parent: 'nope' })).toThrow(/parent/);
    expect(() => prepareGallery({ ...base, signingAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' })).toThrow(/signing-address/);
    expect(() => prepareGallery({ ...base, signature: 'not base64!' })).toThrow(/base64/);
  });
});

describe('chain-setup helpers', () => {
  it('collection-address matches the policy signer and refuses mainnet', () => {
    const key = '07'.repeat(32);
    expect(collectionAddressFromKeyHex(`${key}\n`, 'signet')).toBe(new InMemoryPolicySigner(Buffer.from(key, 'hex'), 'signet').collectionAddress());
    expect(() => collectionAddressFromKeyHex(key, 'mainnet')).toThrow(/mainnet/);
    expect(() => collectionAddressFromKeyHex('abc', 'signet')).toThrow(/32 bytes/);
  });
});

describe('CLIs (node, no network)', () => {
  const run = (script: string, args: string[]) => execFileSync(process.execPath, [join(svc, 'scripts', script), ...args], { encoding: 'utf8' });

  it('prepare-parent writes the same files twice and prints the command + env', () => {
    const [a, b] = [tmp(), tmp()];
    const args = ['--network', 'signet', '--fee-rate', '2', '--collection-address', 'tb1pcoll'];
    const out = run('prepare-parent.mjs', [...args, '--out', a]);
    run('prepare-parent.mjs', [...args, '--out', b]);
    for (const f of ['charter.html', 'parent.metadata.cbor', 'parent.metadata.json', 'plan.json'])
      expect(readFileSync(join(a, f), 'utf8'), f).toBe(readFileSync(join(b, f), 'utf8'));
    expect(out).toContain('wallet inscribe --fee-rate 2 --postage 10000sat');
    expect(out).toContain('COLLECTION_ADDRESS=tb1pcoll');
    expect(JSON.parse(readFileSync(join(a, 'plan.json'), 'utf8')).kind).toBe('degent.club/chain-setup/parent');
  });

  it('prepare-gallery pass 1 prints the message; --help exits 0', () => {
    const dir = tmp();
    const out = run('prepare-gallery.mjs', ['--network', 'regtest', '--fee-rate', '2', '--parent', PARENT, '--signing-address', regtestAddress(7), '--out', dir]);
    expect(out).toContain('degent.club Gallery v1: 4112 members, sha256 e9c7ef57');
    expect(readFileSync(join(dir, 'gallery.sha256'), 'utf8')).toMatch(/^e9c7ef57[0-9a-f]{56} {2}gallery\.json\n$/);
    expect(run('prepare-gallery.mjs', ['--help'])).toContain('usage');
    expect(run('prepare-parent.mjs', ['--help'])).toContain('usage');
  });
});
