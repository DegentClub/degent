#!/usr/bin/env node
/**
 * reconcile-count — one certified count for the collection (products/degent/docs/site-spec.md, "Known defects":
 * site 4,027 minted / 1,470 MB vs collection.json 4,112 vs an internal 4,113 / 1,508 MB).
 *
 * Usage (from the repository root):
 *   node products/degent/services/mint/scripts/reconcile-count.mjs [--roster products/degent/services/mint/data/roster.json]
 *        [--ord <ord base url>] [--export <ids file>] [--claimed-count 4027] [--claimed-mb 1470]
 *        [--out <prefix>] [--cache .reconcile-cache.json] [--concurrency 8] [--site-only]
 *   node products/degent/services/mint/scripts/reconcile-count.mjs --help
 *
 * --export: inscription ids exported from Magic Eden or elsewhere: a JSON array (strings or objects with
 *           id / inscriptionId / inscription_id / tokenId), an object wrapping one (tokens/items/...), or text.
 * --ord:    sums ord `GET /r/inscription/<id>` content_length (cached in --cache; re-runs only fetch new ids).
 * The internal-analysis figure from the site spec (4,113 / 1,508 MB) is explained too unless --site-only.
 * Writes <prefix>.json and <prefix>.md (default prefix: count-report) and prints the markdown.
 * Without --ord the script is offline; nothing else touches the network.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/chain-prep.mjs';
import { DEFAULT_CLAIMS, INTERNAL_ANALYSIS, fetchOrdSizes, normaliseRoster, parseExport, reconcile, toMarkdown } from './lib/reconcile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`usage: node scripts/reconcile-count.mjs [--roster data/roster.json] [--ord <url>] [--export <ids file>]
       [--claimed-count ${DEFAULT_CLAIMS.count}] [--claimed-mb ${DEFAULT_CLAIMS.megabytes}] [--out count-report] [--cache .reconcile-cache.json] [--concurrency 8]

Certified count + byte total with every discrepancy explained (JSON + markdown). Offline unless --ord is given.`);
  process.exit(0);
}

try {
  const rosterPath = typeof args.roster === 'string' ? resolve(args.roster) : resolve(here, '..', 'data/roster.json');
  const rawRoster = JSON.parse(await readFile(rosterPath, 'utf8'));
  const exportIds = typeof args.export === 'string' ? parseExport(await readFile(resolve(args.export), 'utf8')) : null;
  const site = {
    label: 'site',
    count: args['claimed-count'] !== undefined ? Number(args['claimed-count']) : DEFAULT_CLAIMS.count,
    megabytes: args['claimed-mb'] !== undefined ? Number(args['claimed-mb']) : DEFAULT_CLAIMS.megabytes,
  };
  // The site's claim first; the internal analysis figure (4,113 / 1,508) is explained alongside unless --site-only.
  const claims = args['site-only'] ? [site] : [site, INTERNAL_ANALYSIS];

  let ord = null;
  const ordUrl = typeof args.ord === 'string' ? args.ord.replace(/\/$/, '') : null;
  if (ordUrl) {
    const cacheFile = typeof args.cache === 'string' ? args.cache : '.reconcile-cache.json';
    const cache = await readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => ({}));
    const ids = normaliseRoster(rawRoster).map((m) => m.id);
    ord = await fetchOrdSizes(ids, { baseUrl: ordUrl, cache, concurrency: Number(args.concurrency || 8) });
    await writeFile(cacheFile, `${JSON.stringify(cache)}\n`);
  }

  const report = reconcile({ roster: rawRoster, exportIds, ord, ordUrl, claims });
  const prefix = typeof args.out === 'string' ? args.out : 'count-report';
  const md = toMarkdown(report);
  await writeFile(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${prefix}.md`, md);
  console.log(md);
  console.error(`wrote ${prefix}.json and ${prefix}.md`);
} catch (e) {
  console.error(`reconcile-count: ${e.message}`);
  process.exit(1);
}
