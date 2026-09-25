/**
 * Fakes for the site's read-only sources: block.space certification (`CertifyApi`) and ord
 * (`OrdApi`). Used by the tests and by `?demo=1`, where every count is labelled demo data.
 *
 * The fake attestation is shaped like degent.club's real one will be: 4,112 members (4,106 legacy
 * items from the inscribed manifest + 6 Open Studio mints linked to the parent), one exclusion,
 * ~1.5 GB of content, and an attribution summary for the Studio mints by the two demo artists of the
 * fake studio (so an artist page can join the certificate, the studio profile and the studio artworks).
 * Numbers, ids, heights and sizes are deterministic. The signature is NOT a real BIP340 signature.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import type { Network } from '@bsh/degent-mint-sdk';
import {
  CertifyApiError,
  CERTIFY_MAX_LIMIT,
  type ArtistItemsPage,
  type Attestation,
  type Attribution,
  type CertifiedItem,
  type CertifyApi,
  type CollectionResponse,
  type ItemsPage,
} from './certifyApi';
import { OrdApiError, ordinalsExplorerBase, type OrdApi, type OrdInscription } from './ordApi';
import { demoArtistAddress, fakeAddress, type CallLog, type DEMO_ARTISTS } from './fakes';

const enc = new TextEncoder();
const h = (s: string) => hex.encode(sha256(enc.encode(s)));
/** Deterministic 0..1 from a label. */
const unit = (s: string) => parseInt(h(s).slice(0, 8), 16) / 0xffffffff;

export const DEMO_COLLECTION_SLUG = 'degents';
export const DEMO_COLLECTION_NAME = 'Decentralized Gentlemen Club';

export interface FakeStudioMint {
  artist: keyof typeof DEMO_ARTISTS;
  artwork: string;
  edition: number;
  /** Sats of a royalty block.space verified from chain data (contract 0.2.0); omitted = not (yet) verified. */
  royaltySats?: number;
}

/** The Open Studio mints in the demo attestation (artworks of the fake studio's seed). */
export const DEMO_STUDIO_MINTS: readonly FakeStudioMint[] = [
  { artist: 'ada', artwork: 'art_demo_chairman', edition: 1, royaltySats: 9_800 },
  { artist: 'bram', artwork: 'art_demo_martini', edition: 1, royaltySats: 9_800 },
  { artist: 'ada', artwork: 'art_demo_chairman', edition: 2, royaltySats: 9_800 },
  { artist: 'ada', artwork: 'art_demo_regen', edition: 1, royaltySats: 9_800 },
  { artist: 'bram', artwork: 'art_demo_martini', edition: 2 },
  { artist: 'ada', artwork: 'art_demo_chairman', edition: 3 },
];

export interface FakeSiteOptions {
  network?: Network;
  log?: CallLog;
  slug?: string;
  /** Legacy (manifest) members; default 4,106 so the total is 4,112 with the six Studio mints. */
  legacyCount?: number;
  studioMints?: readonly FakeStudioMint[];
  /** Make every certify call fail with this error (live-mode failure paths). */
  certifyError?: CertifyApiError;
  /** Make ord details fail (the lightbox then shows only what the certificate says). */
  ordFails?: boolean;
}

export interface FakeSiteState {
  items: CertifiedItem[];
  response: CollectionResponse;
  /** Inscription ids whose ord details were served (prefetch/caching assertions). */
  ordServed: string[];
}

export interface FakeSite {
  certify: CertifyApi;
  ord: OrdApi;
  state: FakeSiteState;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

/** Build the demo membership and its attestation (pure; cached per option set). */
export function buildDemoCollection(o: { network: Network; slug: string; legacyCount: number; studioMints: readonly FakeStudioMint[] }): { items: CertifiedItem[]; response: CollectionResponse } {
  const items: CertifiedItem[] = [];
  let number = 23_851_204;
  let height = 790_112;
  for (let i = 0; i < o.legacyCount; i++) {
    const r = unit(`len|${i}`);
    // 200-614 kB, skewed low: mean ~365 kB (~1.5 GB in all), like the legacy collection.
    const contentLength = Math.round(200_000 + 360_000 * (0.7 * r * r + 0.45 * r));
    items.push({
      inscriptionId: `${h(`degent|legacy|${i}`)}i0`,
      number,
      contentLength,
      contentType: unit(`type|${i}`) < 0.82 ? 'image/jpeg' : 'image/png',
      height,
      sources: ['manifest'],
    });
    number += 1 + Math.floor(unit(`num|${i}`) * 2_400);
    if (unit(`h|${i}`) < 0.18) height += 1 + Math.floor(unit(`hh|${i}`) * 6);
  }
  let snum = 109_402_881;
  let sheight = 914_806;
  o.studioMints.forEach((m, j) => {
    const attribution: Attribution = {
      artist: demoArtistAddress(m.artist, o.network),
      artwork: m.artwork,
      edition: m.edition,
      studio: 'degent.club',
      ...(m.royaltySats !== undefined ? { royalty: { txid: h(`degent|funding|${j}`), vout: 1, sats: m.royaltySats, verified: true as const } } : {}),
    };
    items.push({
      inscriptionId: `${h(`degent|studio|${j}`)}i0`,
      number: snum,
      contentLength: 248_000 + Math.round(unit(`slen|${j}`) * 4_000),
      contentType: 'image/png',
      height: sheight,
      sources: ['parent-children'],
      attribution,
    });
    snum += 3_000 + Math.floor(unit(`snum|${j}`) * 90_000);
    sheight += 1 + Math.floor(unit(`sh|${j}`) * 40);
  });

  const sizes = items.map((i) => i.contentLength).sort((a, b) => a - b);
  const total = sizes.reduce((a, b) => a + b, 0);
  const rows = items.map((i) => (i.attribution ? [i.inscriptionId, i.number, i.contentLength, i.attribution] : [i.inscriptionId, i.number, i.contentLength]));
  const editions: Record<string, number> = {};
  const artists = new Set<string>();
  let royaltiesVerified = 0;
  let royaltySats = 0;
  for (const i of items) {
    if (!i.attribution) continue;
    editions[i.attribution.artwork] = (editions[i.attribution.artwork] ?? 0) + 1;
    artists.add(i.attribution.artist);
    if (i.attribution.royalty) {
      royaltiesVerified++;
      royaltySats += i.attribution.royalty.sats;
    }
  }
  const parentId = `${h('degent|parent')}i0`;
  const studioCount = o.studioMints.length;
  const attestation: Attestation = {
    collection: { slug: o.slug, name: DEMO_COLLECTION_NAME, parentInscriptionId: parentId },
    method: 'parent-children+manifest',
    sources: [
      { type: 'parent-children', parentInscriptionId: parentId, pages: 1, listed: studioCount + 1, accepted: studioCount, excluded: 1 },
      { type: 'manifest', manifestInscriptionId: `${h('degent|manifest')}i0`, manifestSha256: h('degent|manifest|sha'), verified: true, listed: o.legacyCount, accepted: o.legacyCount, excluded: 0 },
    ],
    stats: {
      itemCount: items.length,
      excludedCount: 1,
      totalContentBytes: total,
      minItemBytes: sizes[0] ?? null,
      maxItemBytes: sizes[sizes.length - 1] ?? null,
      medianItemBytes: median(sizes),
      firstInscriptionNumber: items[0]?.number ?? null,
      lastInscriptionNumber: items[items.length - 1]?.number ?? null,
      totalRevealVbytes: items.reduce((a, i) => a + Math.ceil(i.contentLength / 4) + 212, 0),
      revealTxCount: items.length,
      itemsDigest: hex.encode(sha256(enc.encode(canonical(rows)))),
      ...(artists.size > 0
        ? { attribution: { artists: artists.size, artworks: Object.keys(editions).length, editions, ...(royaltiesVerified > 0 ? { royaltiesVerified, royaltySats } : {}) } }
        : {}),
    },
    asOfBlockHeight: 915_020,
    issuedAt: '2026-09-20T12:00:00.000Z',
    keyId: h('demo-key').slice(0, 16),
    signature: h('demo-sig-1') + h('demo-sig-2'),
  };
  return {
    items,
    response: {
      attestation,
      digest: h(canonical(attestation)),
      exclusions: [{ inscriptionId: `${h('degent|not-a-member')}i0`, source: 'parent-children', reason: 'after_as_of_height' }],
    },
  };
}

const cache = new Map<string, { items: CertifiedItem[]; response: CollectionResponse }>();

function cursorOf(index: number): string {
  return `k1.${index.toString(36)}`;
}

function indexOf(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const m = /^k1\.([0-9a-z]+)$/.exec(cursor);
  if (!m) throw new CertifyApiError(400, 'bad_request', 'Malformed cursor.');
  return parseInt(m[1]!, 36);
}

function limitOf(limit: number | undefined): number {
  const l = limit ?? 100;
  if (!Number.isInteger(l) || l < 1 || l > CERTIFY_MAX_LIMIT) throw new CertifyApiError(400, 'bad_request', 'limit must be 1..500');
  return l;
}

/** An SVG placeholder "Degent" for demo tiles: a lacquer backdrop, a frog-green face and a bowtie. */
export function demoDegentSvg(label: string): string {
  const hue = Math.floor(unit(`hue|${label}`) * 360);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},55%,10%)"/></linearGradient></defs>` +
    `<rect width="100" height="100" fill="url(#g)"/>` +
    `<ellipse cx="50" cy="44" rx="24" ry="19" fill="#4f9d4a"/><circle cx="41" cy="37" r="6" fill="#f5f5f0"/><circle cx="59" cy="37" r="6" fill="#f5f5f0"/>` +
    `<circle cx="42" cy="38" r="2.6" fill="#111"/><circle cx="60" cy="38" r="2.6" fill="#111"/>` +
    `<path d="M28 100 Q30 68 50 66 Q70 68 72 100 Z" fill="#111"/><path d="M44 66 L50 80 L56 66 Z" fill="#f5f5f0"/>` +
    `<path d="M50 70 L40 65 L40 75 Z M50 70 L60 65 L60 75 Z" fill="#c21d2f"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function createFakeSite(opts: FakeSiteOptions = {}): FakeSite {
  const log = opts.log ?? [];
  const network = opts.network ?? 'mainnet';
  const slug = opts.slug ?? DEMO_COLLECTION_SLUG;
  const legacyCount = opts.legacyCount ?? 4_106;
  const studioMints = opts.studioMints ?? DEMO_STUDIO_MINTS;
  const key = `${network}|${slug}|${legacyCount}|${JSON.stringify(studioMints)}`;
  let built = cache.get(key);
  if (!built) {
    built = buildDemoCollection({ network, slug, legacyCount, studioMints });
    cache.set(key, built);
  }
  const { items, response } = built;
  const byId = new Map(items.map((it, i) => [it.inscriptionId, { item: it, index: i }]));
  const state: FakeSiteState = { items, response, ordServed: [] };

  const guard = (s: string) => {
    if (opts.certifyError) throw opts.certifyError;
    if (s !== slug) throw new CertifyApiError(404, 'collection_not_found', `No collection ${s}`);
  };
  const page = <T extends object>(list: CertifiedItem[], cursor: string | null | undefined, limit: number | undefined, extra: T) => {
    const start = indexOf(cursor);
    const l = limitOf(limit);
    const slice = list.slice(start, start + l);
    const next = start + l < list.length ? cursorOf(start + l) : null;
    return { slug, asOfBlockHeight: response.attestation.asOfBlockHeight, itemsDigest: response.attestation.stats.itemsDigest, ...extra, items: slice.map((i) => ({ ...i })), nextCursor: next };
  };

  const certify: CertifyApi = {
    async getCollection(s) {
      log.push('certify.getCollection');
      guard(s);
      return structuredClone(response);
    },
    async listItems(s, query) {
      log.push('certify.listItems');
      guard(s);
      return page(items, query?.cursor, query?.limit, {}) as ItemsPage;
    },
    async listArtistItems(s, address, query) {
      log.push('certify.listArtistItems');
      guard(s);
      const mine = items.filter((i) => i.attribution?.artist === address);
      if (mine.length === 0) throw new CertifyApiError(404, 'artist_not_found', 'No member is attributed to this address.');
      const artworks = new Set(mine.map((i) => i.attribution!.artwork)).size;
      const paid = mine.filter((i) => i.attribution!.royalty);
      const royalties = paid.length > 0 ? { royaltiesVerified: paid.length, royaltySats: paid.reduce((a, i) => a + i.attribution!.royalty!.sats, 0) } : {};
      return page(mine, query?.cursor, query?.limit, { artist: address, itemCount: mine.length, artworks, ...royalties }) as ArtistItemsPage;
    },
  };

  const explorer = ordinalsExplorerBase(network, 'http://localhost:8080');
  const ord: OrdApi = {
    async getInscription(id) {
      log.push('ord.getInscription');
      if (opts.ordFails) throw new OrdApiError(503, 'ord is unavailable (fake)');
      const hit = byId.get(id);
      if (!hit) throw new OrdApiError(404, `No inscription ${id}`);
      state.ordServed.push(id);
      const { item, index } = hit;
      const details: OrdInscription = {
        id,
        number: item.number,
        address: fakeAddress(`holder|${index % 211}`, network),
        contentType: item.contentType,
        contentLength: item.contentLength,
        timestamp: 1_681_000_000 + (item.height - 785_000) * 600 + (index % 7) * 13,
        height: item.height,
        fee: Math.ceil(item.contentLength / 4) * (6 + (index % 9)),
        sat: null,
      };
      return details;
    },
    contentUrl: (id) => demoDegentSvg(id),
    inscriptionUrl: (id) => `${explorer}/inscription/${id}`,
  };

  return { certify, ord, state };
}
