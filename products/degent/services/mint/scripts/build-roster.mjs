#!/usr/bin/env node
/**
 * build-roster: turn the hand-maintained marketplace manifest (collection.json, an array of
 * { name: "Degent #N", inscription_id, inscription_number, sat, size_kb }) into data/roster.json, the
 * Gallery roster the mint service serves as the first 4,112 Register members (ADR-0007 §4).
 *
 * Usage:
 *   node scripts/build-roster.mjs --in ../../../../../Degent-Marketplace/public/collection.json [--out data/roster.json]
 *        [--indexer https://ordinals.com]   # optional: enrich height/timestamp from ord /r/inscription/<id>
 *
 * Deterministic: entries are sorted by n, keys are in a fixed order, and the file ends with a newline.
 * Without --indexer, height and timestamp are null (the explorer then sorts "height" by inscription number).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] === undefined || arr[i + 1].startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);
if (args.help || !args.in) {
  console.log('usage: node scripts/build-roster.mjs --in <collection.json> [--out data/roster.json] [--indexer <ord base url>]');
  process.exit(args.help ? 0 : 2);
}
const out = resolve(here, '..', args.out || 'data/roster.json');

const raw = JSON.parse(await readFile(resolve(args.in), 'utf8'));
if (!Array.isArray(raw)) throw new Error('collection.json must be an array');

export function toRoster(items) {
  const seen = new Set();
  const members = items.map((it) => {
    const m = /^Degent #(\d+)$/.exec(String(it.name ?? ''));
    if (!m) throw new Error(`unexpected name: ${it.name}`);
    const n = Number(m[1]);
    if (seen.has(n)) throw new Error(`duplicate Degent #${n}`);
    seen.add(n);
    if (!/^[0-9a-f]{64}i\d+$/.test(it.inscription_id)) throw new Error(`bad inscription id for #${n}`);
    const sizeKb = Number(it.size_kb);
    if (!Number.isFinite(sizeKb) || sizeKb <= 0) throw new Error(`bad size_kb for #${n}`);
    return {
      n,
      inscriptionId: it.inscription_id,
      inscriptionNumber: Number.isSafeInteger(it.inscription_number) ? it.inscription_number : null,
      sat: Number.isSafeInteger(it.sat) ? it.sat : null,
      sizeKb,
      bytes: Math.round(sizeKb * 1024),
      height: null,
      timestamp: null,
    };
  });
  members.sort((a, b) => a.n - b.n);
  for (let i = 0; i < members.length; i++) if (members[i].n !== i + 1) throw new Error(`gap in numbering at #${i + 1}`);
  return members;
}

const members = toRoster(raw);

if (args.indexer) {
  const base = String(args.indexer).replace(/\/$/, '');
  let done = 0;
  for (const m of members) {
    const res = await fetch(`${base}/r/inscription/${m.inscriptionId}`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const j = await res.json();
      m.height = Number.isSafeInteger(j.height) ? j.height : null;
      m.timestamp = Number.isSafeInteger(j.timestamp) ? new Date(j.timestamp * 1000).toISOString() : null;
      if (Number.isSafeInteger(j.content_length)) m.bytes = j.content_length;
    }
    if (++done % 200 === 0) process.stderr.write(`  ${done}/${members.length}\n`);
  }
}

const roster = {
  version: 1,
  collection: 'Decentralized Gentlemen Club',
  source: 'Degent-Marketplace/public/collection.json',
  generatedAt: new Date().toISOString(),
  count: members.length,
  members,
};
await writeFile(out, `${JSON.stringify(roster, null, 1)}\n`);
process.stderr.write(`wrote ${out}: ${members.length} members, ${(members.reduce((a, m) => a + m.bytes, 0) / 1024 / 1024).toFixed(1)} MiB\n`);
