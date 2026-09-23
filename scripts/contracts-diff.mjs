#!/usr/bin/env node
/**
 * contracts:diff — the delta between our AsyncAPI order-status contract and the platform's canonical copy of
 * the shared `degent.mint.order.{status}` topic (deps/scribbit/contracts/asyncapi/platform-events.yaml).
 * ADR-0005 added statuses here first; this prints what the platform PR still has to add. Exit code 0 when
 * the sets are equal, 1 when we carry extras (a platform PR is pending), 2 when the platform has values we
 * lack (we must catch up).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'products/degent/services/mint/package.json'));
const { parse } = require('yaml');

const ours = parse(readFileSync(join(root, 'contracts/asyncapi/degent-mint.yaml'), 'utf8'));
const theirsDoc = parse(readFileSync(join(root, 'deps/scribbit/contracts/asyncapi/platform-events.yaml'), 'utf8'));
const theirs = Object.values(theirsDoc.channels).find((c) => c.address === ours.channels.orderStatus.address);
if (!theirs) {
  console.error('platform-events.yaml does not declare', ours.channels.orderStatus.address);
  process.exit(2);
}
const ourEnum = ours.channels.orderStatus.parameters.status.enum;
const theirEnum = theirs.parameters.status.enum;
const extra = ourEnum.filter((s) => !theirEnum.includes(s));
const missing = theirEnum.filter((s) => !ourEnum.includes(s));
const msg = theirsDoc.components.messages.MintOrderStatusChanged;

console.log(`topic ${ours.channels.orderStatus.address}`);
console.log(`  ours (contracts/asyncapi/degent-mint.yaml):            ${ourEnum.length} statuses`);
console.log(`  platform (deps/scribbit, x-topic-version ${msg?.['x-topic-version'] ?? '?'}): ${theirEnum.length} statuses`);
if (!extra.length && !missing.length) {
  console.log('  in sync: the platform carries every status we emit.');
  process.exit(0);
}
if (extra.length) {
  console.log(`  statuses to add to platform-events.yaml (channel parameter enum, MintOrderStatusChanged.status and .previousStatus):`);
  for (const s of extra) console.log(`    + ${s}`);
}
if (missing.length) {
  console.log('  statuses the platform has that we do not emit:');
  for (const s of missing) console.log(`    - ${s}`);
}
process.exit(extra.length ? 1 : 2);
