/**
 * chain-setup — the two launch checks that need the service's own code (docs/LAUNCH-CHAIN-SETUP.md).
 * Run with tsx (a dev dependency of this package); no network.
 *
 *   pnpm --filter @bsh/degent-mint chain-setup collection-address --network signet --key-file <file>
 *     COLLECTION_ADDRESS for SIGNER=memory (signet/testnet/regtest only): the exact address InMemoryPolicySigner
 *     derives from PARENT_KEY_FILE, so startup's "COLLECTION_ADDRESS does not match" check passes.
 *
 *   pnpm --filter @bsh/degent-mint chain-setup verify-gallery --network <net> --dir <prepare-gallery out>
 *     Re-hashes gallery.json, rebuilds the message, decodes gallery.metadata.cbor and verifies the BIP-322 signature
 *     with @bsh/identity (the same verifier the member votes use). Exit 0 = ok.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hexToBytes } from '@noble/hashes/utils.js';
import { verifyBip322Simple } from '@bsh/identity';
import type { Network } from '@bsh/inscription';
import { InMemoryPolicySigner } from '../src/adapters/in-memory-policy-signer.js';
import { decodeCbor, galleryMessage, sha256Hex } from './lib/chain-prep.mjs';

const NETWORKS: Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

export function collectionAddressFromKeyHex(hex: string, network: Network): string {
  if (network === 'mainnet') throw new Error('SIGNER=memory keys are refused on mainnet; the KMS signer provides the mainnet address');
  const h = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('key file must contain 32 bytes of hex');
  return new InMemoryPolicySigner(hexToBytes(h), network, undefined, { warn: () => {} }).collectionAddress();
}

export interface GalleryVerification {
  ok: boolean;
  problems: string[];
  sha256: string;
  count: number;
}

/** Verify a prepare-gallery output directory (pass 2, with gallery.metadata.cbor). Never throws on bad data. */
export function verifyGalleryDir(dir: string, network: Network): GalleryVerification {
  const problems: string[] = [];
  const content = readFileSync(join(dir, 'gallery.json'));
  const sha: string = sha256Hex(content);
  let count = 0;
  try {
    const g = JSON.parse(content.toString('utf8')) as { version: number; members: Array<{ n: number; id: string }> };
    count = g.members.length;
    if (g.version !== 1) problems.push('gallery.version is not 1');
    if (!g.members.every((m, i) => m.n === i + 1)) problems.push('members are not numbered 1..count in order');
    if (new Set(g.members.map((m) => m.id)).size !== count) problems.push('duplicate inscription ids');
  } catch (e) {
    problems.push(`gallery.json: ${(e as Error).message}`);
  }
  let meta: Record<string, unknown> = {};
  try {
    meta = decodeCbor(new Uint8Array(readFileSync(join(dir, 'gallery.metadata.cbor')))) as Record<string, unknown>;
  } catch (e) {
    problems.push(`gallery.metadata.cbor: ${(e as Error).message}`);
    return { ok: false, problems, sha256: sha, count };
  }
  if (meta.kind !== 'degent.club/gallery' || meta.version !== 1) problems.push('metadata kind/version');
  if (meta.sha256 !== sha) problems.push('metadata sha256 differs from sha256(gallery.json)');
  if (meta.count !== count) problems.push('metadata count differs from the member count');
  let expected = '';
  try {
    expected = galleryMessage(sha, meta.parent, count);
  } catch (e) {
    problems.push(`metadata parent: ${(e as Error).message}`);
  }
  if (meta.message !== expected) problems.push('metadata message is not the canonical message');
  const onDisk = readFileSync(join(dir, 'gallery.message.txt'), 'utf8');
  if (onDisk !== expected) problems.push('gallery.message.txt is not the canonical message');
  if (typeof meta.signer !== 'string' || typeof meta.signature !== 'string') problems.push('metadata signer/signature missing');
  else {
    const v = verifyBip322Simple(meta.signer, network, expected, meta.signature);
    if (!v.valid) problems.push(`BIP-322 signature invalid: ${v.reason}`);
  }
  return { ok: problems.length === 0, problems, sha256: sha, count };
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const opt = (k: string) => {
    const i = rest.indexOf(`--${k}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const network = opt('network') as Network | undefined;
  if (!cmd || !network || !NETWORKS.includes(network) || (cmd !== 'collection-address' && cmd !== 'verify-gallery')) {
    console.log('usage: tsx scripts/chain-setup.ts collection-address --network <net> --key-file <file>\n       tsx scripts/chain-setup.ts verify-gallery --network <net> --dir <dir>');
    return cmd === '--help' ? 0 : 2;
  }
  if (cmd === 'collection-address') {
    const file = opt('key-file');
    if (!file) return (console.error('--key-file is required'), 2);
    console.log(collectionAddressFromKeyHex(readFileSync(file, 'utf8'), network));
    return 0;
  }
  const dir = opt('dir');
  if (!dir) return (console.error('--dir is required'), 2);
  const r = verifyGalleryDir(dir, network);
  console.log(r.ok ? `ok: ${r.count} members, sha256 ${r.sha256}, signature valid` : `FAILED:\n  - ${r.problems.join('\n  - ')}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
