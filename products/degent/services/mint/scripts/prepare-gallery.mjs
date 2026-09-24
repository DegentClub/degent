#!/usr/bin/env node
/**
 * prepare-gallery — the signed Gallery of the first 4,112 Degents (docs/REGISTER.md §1.2,
 * docs/LAUNCH-CHAIN-SETUP.md). Pure: no network, no keys.
 *
 * Usage (from the repository root):
 *   Pass 1  node products/degent/services/mint/scripts/prepare-gallery.mjs --network <net> --fee-rate <sat/vB> \
 *               --parent <PARENT_INSCRIPTION_ID> --signing-address <announced address> --out <dir> \
 *               [--roster products/degent/services/mint/data/roster.json] [--postage 10000] [--destination <addr>]
 *           -> gallery.json, gallery.sha256, gallery.message.txt, plan.json
 *   (owner signs gallery.message.txt with the signing address, BIP-322 simple)
 *   Pass 2  the same command plus --signature <base64>
 *           -> + gallery.metadata.cbor (+ .json) and the `ord wallet inscribe --parent` command
 *   node products/degent/services/mint/scripts/prepare-gallery.mjs --help
 *
 * gallery.json is `{"version":1,"members":[{"n":1,"id":"…i0"},…]}` (compact, ordered by n, 4,112 unique ids).
 * The metadata carries sha256(gallery.json), the exact message, the signer and the signature, so a forked
 * gallery cannot impersonate it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, prepareGallery } from './lib/chain-prep.mjs';
import { writeOut } from './lib/write-out.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.out || !args.network || !args['fee-rate'] || !args.parent || !args['signing-address']) {
  console.log(`usage: node scripts/prepare-gallery.mjs --network <net> --fee-rate <sat/vB> --parent <PARENT_INSCRIPTION_ID>
       --signing-address <announced address> --out <dir> [--signature <base64>] [--roster data/roster.json]
       [--postage 10000] [--destination <ord wallet address>]

Builds the Gallery JSON of the first 4,112 from the roster, its SHA-256 and the BIP-322 message to sign; with
--signature also the CBOR metadata and the ord inscribe command (docs/LAUNCH-CHAIN-SETUP.md). No network.`);
  process.exit(args.help ? 0 : 2);
}

try {
  const rosterPath = typeof args.roster === 'string' ? resolve(args.roster) : resolve(here, '..', 'data/roster.json');
  const prepared = prepareGallery({
    network: args.network,
    feeRate: args['fee-rate'],
    postage: args.postage,
    parent: String(args.parent),
    signingAddress: String(args['signing-address']),
    signature: typeof args.signature === 'string' ? args.signature : undefined,
    destination: typeof args.destination === 'string' ? args.destination : undefined,
    roster: JSON.parse(readFileSync(rosterPath, 'utf8')),
    ...(typeof args.roster === 'string' ? { rosterPath } : {}),
  });
  const dir = writeOut(String(args.out), prepared);
  const { plan } = prepared;
  console.log(`wrote ${plan.files.map((f) => `${f.path} (${f.bytes} B)`).join(', ')}, plan.json -> ${dir}
gallery: ${plan.gallery.count} members, ${plan.gallery.bytes} bytes, sha256 ${plan.gallery.sha256}`);
  if (!plan.inputs.signature) {
    console.log(`
Next: sign this exact message (BIP-322 simple) with ${plan.inputs.signingAddress}, then re-run with --signature <base64>:
${plan.gallery.message}`);
  } else {
    const step = (id) => plan.steps.find((s) => s.id === id);
    console.log(`
1. Verify:   ${step('gallery.verify-signature').run}
2. From ${dir}, dry run, then inscribe (the parent must be in this ord wallet):
   ${step('gallery.inscribe').run}
3. Set GALLERY_INSCRIPTION_ID=<inscriptions[0].id>, then run the parent plan's parent.handoff step.`);
  }
} catch (e) {
  console.error(`prepare-gallery: ${e.message}`);
  process.exit(1);
}
