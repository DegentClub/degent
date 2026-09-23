#!/usr/bin/env node
/**
 * blockspace-query — reproducible "largest collection on Bitcoin by blockspace" report.
 *
 * Usage (from products/degent/services/mint):
 *   node scripts/blockspace-query.mjs --collection data/roster.json [--compare compare.json]
 *        [--indexer https://ordinals.com] [--concurrency 8] [--out report.json] [--cache .blockspace-cache.json]
 *   node scripts/blockspace-query.mjs --help
 *
 * --collection: the Register roster (data/roster.json, { members: [{ inscriptionId, ... }] }) or the legacy
 *               marketplace manifest (an array of { inscription_id, name? }).
 * compare.json: { "<collection name>": ["<inscription_id>", ...], ... } for other collections
 *               (export ids from Magic Eden's collection API or an ord wallet; see docs/REGISTER.md).
 *
 * For every inscription id the script asks the ord recursive endpoint
 *   GET <indexer>/r/inscription/<id>   → { content_length, height, ... }
 * and sums content_length. ord's recursive endpoints are served by any ord instance with
 * `--index-sats` not required, so anyone can re-run this against their own node and get the
 * same totals. Results are cached in .blockspace-cache.json so re-runs only fetch new ids.
 */
import { readFile, writeFile } from 'node:fs/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, []),
);
const INDEXER = (args.indexer || 'https://ordinals.com').replace(/\/$/, '');
const CONCURRENCY = Number(args.concurrency || 8);
const OUT = args.out || 'blockspace-report.json';
const CACHE_FILE = args.cache || '.blockspace-cache.json';

if (args.help || !args.collection) {
  console.log('usage: node scripts/blockspace-query.mjs --collection data/roster.json [--compare compare.json] [--indexer <ord base>] [--concurrency 8] [--out report.json] [--cache <file>]');
  process.exit(args.help ? 0 : 2);
}

const cache = await readFile(CACHE_FILE, 'utf8').then(JSON.parse).catch(() => ({}));

async function fetchOne(id) {
  if (cache[id]) return cache[id];
  const res = await fetch(`${INDEXER}/r/inscription/${id}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const j = await res.json();
  const rec = { bytes: j.content_length ?? 0, height: j.height ?? null, number: j.number ?? null };
  cache[id] = rec;
  return rec;
}

async function sumCollection(ids) {
  let done = 0;
  const failures = [];
  const results = new Array(ids.length);
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++;
      try {
        results[i] = await fetchOne(ids[i]);
      } catch (e) {
        failures.push(String(e.message || e));
        results[i] = { bytes: 0, height: null, number: null };
      }
      if (++done % 200 === 0) process.stderr.write(`  ${done}/${ids.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const bytes = results.reduce((a, r) => a + r.bytes, 0);
  const heights = results.map((r) => r.height).filter((h) => h != null);
  return {
    count: ids.length,
    bytes,
    gib: +(bytes / 2 ** 30).toFixed(3),
    medianKB: +(median(results.map((r) => r.bytes)) / 1024).toFixed(1),
    minHeight: heights.length ? Math.min(...heights) : null,
    maxHeight: heights.length ? Math.max(...heights) : null,
    failures,
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const rosterDoc = JSON.parse(await readFile(args.collection, 'utf8'));
const roster = Array.isArray(rosterDoc) ? rosterDoc : rosterDoc.members;
const ids = roster.map((r) => (typeof r === 'string' ? r : r.inscriptionId ?? r.inscription_id));
process.stderr.write(`Degent roster: ${ids.length} ids via ${INDEXER}\n`);
const report = { generatedAt: new Date().toISOString(), indexer: INDEXER, collections: {} };
report.collections['Decentralized Gentlemen Club'] = await sumCollection(ids);

if (args.compare) {
  const cmp = JSON.parse(await readFile(args.compare, 'utf8'));
  for (const [name, list] of Object.entries(cmp)) {
    process.stderr.write(`${name}: ${list.length} ids\n`);
    report.collections[name] = await sumCollection(list);
  }
}

await writeFile(CACHE_FILE, JSON.stringify(cache));
await writeFile(OUT, JSON.stringify(report, null, 2));

// Markdown table to stdout — paste into the monthly Register post.
const rows = Object.entries(report.collections).sort((a, b) => b[1].bytes - a[1].bytes);
console.log('| Collection | Inscriptions | Blockspace | Median | Blocks |');
console.log('|---|---:|---:|---:|---|');
for (const [name, c] of rows) {
  console.log(`| ${name} | ${c.count.toLocaleString()} | ${c.gib} GiB | ${c.medianKB} KB | ${c.minHeight ?? '?'}–${c.maxHeight ?? '?'} |`);
}
console.log(`\nGenerated ${report.generatedAt} against ${INDEXER}. Re-run: node scripts/blockspace-query.mjs --collection data/roster.json --compare compare.json`);
