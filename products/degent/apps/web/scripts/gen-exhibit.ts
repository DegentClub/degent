/**
 * Build-time generator for the Full Block Exhibit's static machine-native surface. Writes into
 * `public/` (Vite copies it to `dist/`), so a purely static deploy still serves them:
 *
 *   public/exhibit/index.json     every Full Block Degent + on-chain facts (from the BUNDLED manifest)
 *   public/exhibit/<n>.json       per-item JSON twin
 *   public/llms.txt               site guide for agents, with the exhibit endpoints
 *   public/sitemap.xml            main routes + one entry per exhibit item
 *
 * The numbers come from the SAME `../src/site/lib/exhibit` code the pages use (one implementation of
 * the maths). The membership here is the bundled manifest, so the emitted index is labelled
 * `source: "bundled", certified: false`: a live deployment with a certification API regenerates it
 * server-side. Run before `vite build` (see package.json). Facts (height/fee/timestamp) are left
 * empty in the static index — they are read per item from ord at view time.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exhibitIndexJson, exhibitItemJson, type LinkBases } from '../src/site/lib/exhibit';
import type { CollectionItem } from '../src/site/services/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const outDir = join(pub, 'exhibit');

const SITE = 'https://degent.club';
const BASES: LinkBases = { ordinals: 'https://ordinals.com', magicEden: 'https://magiceden.io', blockspace: 'https://block.space' };

const items = JSON.parse(readFileSync(join(root, 'src/data/collection.json'), 'utf8')) as CollectionItem[];
const index = exhibitIndexJson({ source: 'bundled', items }, BASES);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
for (const it of items) {
  if (!index.items.some((x) => x.number === it.number)) continue;
  writeFileSync(join(outDir, `${it.number}.json`), JSON.stringify(exhibitItemJson(it, BASES), null, 2) + '\n');
}

// llms.txt: a short, honest guide for agents.
const llms = `# degent.club — Decentralized Gentlemen Club

> A community-driven ordinal collection of Pepes in tuxedos on Bitcoin, and a non-custodial mint.
> Own rung of the block.space learning ladder. Numbers are block.space-certified or bundled-manifest
> (labelled); the retired live-site figures (4,027 / 1,470 MB) are never used.

## Full Block Exhibit
A Full Block Degent is one artwork that fills nearly a whole Bitcoin block (~3.9M of the 4,000,000
weight-unit consensus limit; a witness byte weighs 1 WU, so ~3.96 MB of content fits in one block —
one per block by construction, ADR-0005).

- /exhibit — gallery of Full Block Degents (content >= 3.5 MB, the SDK "fullblock" tier floor)
- /exhibit/{n} — one exhibit (plate, one-block visualization to scale, on-chain facts, placard, links)
- /exhibit/index.json — all Full Block Degents with facts and block-fraction (machine twin)
- /exhibit/{n}.json — per-item JSON twin (also /exhibit/{n}?format=json)
- Schema: schemas/exhibit-index.schema.json, schemas/exhibit-item.schema.json

Reveal weight/vsize/block-fraction are ESTIMATED from content length via @bsh/inscription and
labelled estimated:true. block.space tools: Transaction X-Ray (/xray/{revealTxid}) and Block Theater
(/theater?block={height}) — ADR-0008.

## Main pages
- / — home
- /collection, /collection/{n} — the certified collection and per-item lightbox
- /mint — the non-custodial mint (ADR-0002, ADR-0005)
- /how-it-works — tiers and lanes
- /comic — the on-chain Degent Chronicles comic
`;
writeFileSync(join(pub, 'llms.txt'), llms);

// sitemap.xml: main routes + exhibit items.
const routes = ['/', '/collection', '/exhibit', '/mint', '/how-it-works', '/comic', '/atelier', '/blog', '/club'];
const urls = [
  ...routes.map((p) => `${SITE}${p}`),
  ...index.items.map((it) => `${SITE}/exhibit/${it.number}`),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
  .map((u) => `  <url><loc>${u}</loc></url>`)
  .join('\n')}\n</urlset>\n`;
writeFileSync(join(pub, 'sitemap.xml'), sitemap);

console.log(`exhibit: ${index.count} full-block items → public/exhibit/*.json, public/llms.txt, public/sitemap.xml (${urls.length} urls)`);
