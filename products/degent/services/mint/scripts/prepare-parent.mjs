#!/usr/bin/env node
/**
 * prepare-parent — everything the owner needs to inscribe the Club parent (docs/REGISTER.md §1.1,
 * docs/LAUNCH-CHAIN-SETUP.md). Pure: no network, no keys; the owner runs the printed ord commands.
 *
 * Usage (from the repository root):
 *   node products/degent/services/mint/scripts/prepare-parent.mjs --network signet|mainnet|testnet|regtest \
 *        --fee-rate <sat/vB> --out <dir> [--postage 10000] [--destination <ord wallet address>] \
 *        [--collection-address <COLLECTION_ADDRESS>] [--name "Decentralized Gentlemen Club"] [--charter 10000]
 *   node products/degent/services/mint/scripts/prepare-parent.mjs --help
 *
 * Writes into --out: charter.html (< 2 KB, link-free), parent.metadata.cbor (+ .json for humans), plan.json
 * (steps, commands, expected outputs, verification commands, env to set). Prints the inscribe command and the env.
 *
 * The parent is inscribed to the owner's ord wallet (--destination), NOT straight to COLLECTION_ADDRESS: ord's
 * `--parent` needs the parent in the wallet that inscribes the Gallery. After the Gallery, the plan's
 * `parent.handoff` step sends it to COLLECTION_ADDRESS, and PARENT_OUTPOINT is where that send puts it.
 */
import { parseArgs, prepareParent } from './lib/chain-prep.mjs';
import { writeOut } from './lib/write-out.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.out || !args.network || !args['fee-rate']) {
  console.log(`usage: node scripts/prepare-parent.mjs --network <net> --fee-rate <sat/vB> --out <dir>
       [--postage 10000] [--destination <ord wallet address>] [--collection-address <addr>] [--name <club name>] [--charter 10000]

Generates the Club parent charter page + CBOR metadata and plan.json (docs/LAUNCH-CHAIN-SETUP.md). No network.`);
  process.exit(args.help ? 0 : 2);
}

try {
  const prepared = prepareParent({
    network: args.network,
    feeRate: args['fee-rate'],
    postage: args.postage,
    destination: typeof args.destination === 'string' ? args.destination : undefined,
    collectionAddress: typeof args['collection-address'] === 'string' ? args['collection-address'] : undefined,
    name: typeof args.name === 'string' ? args.name : undefined,
    charter: args.charter,
  });
  const dir = writeOut(String(args.out), prepared);
  const { plan } = prepared;
  const step = (id) => plan.steps.find((s) => s.id === id);
  console.log(`wrote ${plan.files.map((f) => `${f.path} (${f.bytes} B)`).join(', ')}, plan.json -> ${dir}

1. From ${dir}, dry run, then inscribe the parent into your ord wallet:
   ${step('parent.inscribe').run}
2. Prepare and inscribe the Gallery as its child (prepare-gallery.mjs; see plan.json step "gallery").
3. Hand the parent to the policy signer's address:
   ${step('parent.handoff').run}
4. Set, then restart degent-mint:
   PARENT_INSCRIPTION_ID=<inscriptions[0].id from step 1>
   PARENT_OUTPOINT=<txid>:<vout> of the parent satpoint after step 3
   COLLECTION_ADDRESS=${plan.env.COLLECTION_ADDRESS.value}`);
} catch (e) {
  console.error(`prepare-parent: ${e.message}`);
  process.exit(1);
}
