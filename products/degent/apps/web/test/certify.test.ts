import { describe, expect, it, vi } from 'vitest';
import { CertifyApiError, createCertifyApi, verifiedRoyaltyOf, type CertifiedItem } from '../src/services/certifyApi';
import { createOrdApi, parseOrdInscription } from '../src/services/ordApi';
import { createFakeSite, DEMO_STUDIO_MINTS } from '../src/services/fakeSite';
import { demoArtistAddress } from '../src/services/fakes';
import { countsFrom, formatGB, formatMB, formatPct, PROJECTED_TARGET } from '../src/lib/counts';
import { createMemberIndex } from '../src/lib/memberIndex';
import { createDetailsCache } from '../src/lib/detailsCache';
import { pageWindow, shownRange, pageCount } from '../src/lib/pagination';
import { readConfig } from '../src/config';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('certify client (blockspace-collections.yaml)', () => {
  it('builds the contract URLs: collection, keyset items with cursor + clamped limit, artist items', async () => {
    const site = createFakeSite();
    const calls: string[] = [];
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/v1/collections/degents')) return jsonResponse(site.state.response);
      return jsonResponse({ slug: 'degents', asOfBlockHeight: 1, itemsDigest: 'aa'.repeat(32), items: [], nextCursor: null, artist: 'x', itemCount: 1, artworks: 1 });
    });
    const api = createCertifyApi({ baseUrl: 'https://certify.test/', fetch: f });
    const col = await api.getCollection('degents');
    expect(col.attestation.stats.itemCount).toBe(4112);
    await api.listItems('degents', { cursor: 'k1.a', limit: 9999 });
    await api.listArtistItems('degents', 'bc1q w', { limit: 0 });
    expect(calls).toEqual([
      'https://certify.test/v1/collections/degents',
      'https://certify.test/v1/collections/degents/items?cursor=k1.a&limit=500',
      'https://certify.test/v1/collections/degents/artists/bc1q%20w?limit=1',
    ]);
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', headers: { accept: 'application/json' } });
  });

  it('maps the edge error body (code + requestId), network failures and malformed bodies', async () => {
    const notFound = createCertifyApi({
      baseUrl: 'https://c.test',
      fetch: async () => jsonResponse({ error: { code: 'artist_not_found', message: 'none', requestId: 'req_1' } }, 404),
    });
    await expect(notFound.listArtistItems('degents', 'bc1qxyz')).rejects.toMatchObject({ status: 404, code: 'artist_not_found', requestId: 'req_1' });
    const down = createCertifyApi({ baseUrl: 'https://c.test', fetch: async () => Promise.reject(new TypeError('offline')) });
    await expect(down.getCollection('degents')).rejects.toMatchObject({ code: 'network_error' });
    const weird = createCertifyApi({ baseUrl: 'https://c.test', fetch: async () => jsonResponse({ attestation: { stats: {} } }) });
    await expect(weird.getCollection('degents')).rejects.toMatchObject({ code: 'bad_response' });
    await expect(weird.getCollection('Not A Slug')).rejects.toBeInstanceOf(CertifyApiError);
  });

  it('config: VITE_CERTIFY_URL and VITE_COLLECTION_SLUG (default degents), comic id validated', () => {
    const d = readConfig({}, '');
    expect(d.certifyUrl).toBe('https://certify.block.space');
    expect(d.collectionSlug).toBe('degents');
    expect(d.comicInscriptionId).toBeNull();
    const c = readConfig({ VITE_CERTIFY_URL: 'https://certify.example/', VITE_COLLECTION_SLUG: 'degent-signet', VITE_COMIC_INSCRIPTION_ID: `${'ab'.repeat(32)}i0` }, '');
    expect(c).toMatchObject({ certifyUrl: 'https://certify.example', collectionSlug: 'degent-signet', comicInscriptionId: `${'ab'.repeat(32)}i0` });
    expect(readConfig({ VITE_COLLECTION_SLUG: 'BAD SLUG', VITE_COMIC_INSCRIPTION_ID: 'nope' }, '')).toMatchObject({ collectionSlug: 'degents', comicInscriptionId: null });
  });
});

describe('fake certificate (demo data)', () => {
  it('is a realistic attestation: 4,112 members, stats consistent with the items, attribution summary for six Studio mints', () => {
    const { state } = createFakeSite();
    const att = state.response.attestation;
    expect(att.stats.itemCount).toBe(4112);
    expect(state.items).toHaveLength(4112);
    expect(att.stats.totalContentBytes).toBe(state.items.reduce((a, i) => a + i.contentLength, 0));
    expect(att.stats.totalContentBytes).toBeGreaterThan(1.4e9);
    expect(att.stats.totalContentBytes).toBeLessThan(1.6e9);
    expect(att.stats.firstInscriptionNumber).toBe(state.items[0]!.number);
    const numbers = state.items.map((i) => i.number);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    expect(new Set(state.items.map((i) => i.inscriptionId)).size).toBe(4112);
    expect(att.stats.attribution).toEqual({
      artists: 2,
      artworks: 3,
      editions: { art_demo_chairman: 3, art_demo_martini: 2, art_demo_regen: 1 },
      royaltiesVerified: 4,
      royaltySats: 39_200,
    });
    expect(state.items.filter((i) => i.attribution)).toHaveLength(DEMO_STUDIO_MINTS.length);
    expect(att.sources.map((s) => s.type)).toEqual(['parent-children', 'manifest']);
    expect(att.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it('pages by keyset cursor over every member exactly once; limits and unknown slugs follow the contract', async () => {
    const { certify } = createFakeSite();
    const seen: CertifiedItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await certify.listItems('degents', { cursor, limit: 500 });
      seen.push(...p.items);
      cursor = p.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(9);
    expect(seen).toHaveLength(4112);
    expect((await certify.listItems('degents')).items).toHaveLength(100);
    await expect(certify.listItems('degents', { limit: 501 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(certify.listItems('degents', { cursor: 'garbage' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(certify.getCollection('other')).rejects.toMatchObject({ status: 404, code: 'collection_not_found' });
  });

  it('serves an artist’s attributed members with whole-artist totals, and 404 artist_not_found otherwise', async () => {
    const { certify } = createFakeSite();
    const ada = demoArtistAddress('ada', 'mainnet');
    const page = await certify.listArtistItems('degents', ada, { limit: 2 });
    expect(page).toMatchObject({ artist: ada, itemCount: 4, artworks: 2, royaltiesVerified: 3, royaltySats: 29_400 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const rest = await certify.listArtistItems('degents', ada, { cursor: page.nextCursor, limit: 2 });
    expect(rest.items.every((i) => i.attribution?.artist === ada)).toBe(true);
    expect(rest.nextCursor).toBeNull();
    await expect(certify.listArtistItems('degents', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).rejects.toMatchObject({ code: 'artist_not_found' });
  });

  it('verifiedRoyaltyOf accepts only a well-formed verified royalty', () => {
    const royalty = { txid: 'ab'.repeat(32), vout: 1, sats: 5000, verified: true as const };
    expect(verifiedRoyaltyOf({ attribution: { artist: 'a', artwork: 'w', royalty } })).toEqual(royalty);
    expect(verifiedRoyaltyOf({ attribution: { artist: 'a', artwork: 'w' } })).toBeNull();
    expect(verifiedRoyaltyOf({ attribution: { artist: 'a', artwork: 'w', royalty: { ...royalty, txid: 'zz' } } })).toBeNull();
    expect(verifiedRoyaltyOf({ attribution: { artist: 'a', artwork: 'w', royalty: { ...royalty, verified: false as unknown as true } } })).toBeNull();
    expect(verifiedRoyaltyOf({})).toBeNull();
  });
});

describe('counts: one source, projected vs certified kept apart', () => {
  it('derives every number from the attestation; the target is a separate constant', () => {
    const { state } = createFakeSite();
    const c = countsFrom(state.response.attestation);
    expect(c.minted).toBe(4112);
    expect(c.bytes).toBe(state.response.attestation.stats.totalContentBytes);
    expect(c.mintedPct).toBeCloseTo((4112 / PROJECTED_TARGET.supply) * 100, 6);
    expect(c.studio).toEqual({ mints: 6, artists: 2, artworks: 3 });
    expect(c.manifestVerified).toBe(true);
    expect(formatMB(1_508_400_000)).toBe('1,508 MB');
    expect(formatGB(3_000_000_000)).toBe('3 GB');
    expect(formatPct(41.12)).toBe('41.12%');
  });

  it('an unverified manifest is reported, and a collection without attribution has no studio line', () => {
    const { state } = createFakeSite({ legacyCount: 10, studioMints: [] });
    const att = structuredClone(state.response.attestation);
    att.sources = att.sources.map((s) => (s.type === 'manifest' ? { ...s, verified: false } : s));
    const c = countsFrom(att);
    expect(c.manifestVerified).toBe(false);
    expect(c.studio).toBeNull();
    expect(c.minted).toBe(10);
  });
});

describe('member index (keyset walk with random access)', () => {
  it('fetches only as far as needed, never twice, and serves peeks from the cache', async () => {
    const site = createFakeSite();
    const spy = vi.spyOn(site.certify, 'listItems');
    const idx = createMemberIndex(site.certify, 'degents', { batch: 500 });
    expect(idx.peek(0, 20)).toBeNull();
    const first = await idx.load(0, 20);
    expect(first.map((i) => i.inscriptionId)).toEqual(site.state.items.slice(0, 20).map((i) => i.inscriptionId));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(idx.peek(480, 500)).toHaveLength(20);
    await idx.load(1000, 1020);
    expect(spy).toHaveBeenCalledTimes(3);
    await idx.load(20, 40);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('“last page” walks to the end once; concurrent loads share one walk', async () => {
    const site = createFakeSite();
    const spy = vi.spyOn(site.certify, 'listItems');
    const idx = createMemberIndex(site.certify, 'degents');
    const [a, b] = await Promise.all([idx.load(4100, 4120), idx.load(4000, 4020)]);
    expect(a).toHaveLength(12);
    expect(b).toHaveLength(20);
    expect(idx.complete()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(9);
    expect(idx.peek(4100, 4120)).toHaveLength(12);
  });

  it('a failed page does not poison later loads', async () => {
    const site = createFakeSite();
    let fail = true;
    const certify = { ...site.certify, listItems: async (...args: Parameters<typeof site.certify.listItems>) => {
      if (fail) throw new CertifyApiError(503, 'upstream_error', 'ord down');
      return site.certify.listItems(...args);
    } };
    const idx = createMemberIndex(certify, 'degents');
    await expect(idx.load(0, 10)).rejects.toMatchObject({ code: 'upstream_error' });
    fail = false;
    expect(await idx.load(0, 10)).toHaveLength(10);
  });
});

describe('ord details: client and cache', () => {
  it('parses ord JSON defensively and builds network-aware explorer links', async () => {
    const id = `${'cd'.repeat(32)}i0`;
    expect(parseOrdInscription(id, { address: 'bc1qa', content_type: 'image/png', content_length: 5, fee: 900, height: 800000, number: 7, timestamp: 1700000000 })).toEqual({
      id,
      number: 7,
      address: 'bc1qa',
      contentType: 'image/png',
      contentLength: 5,
      timestamp: 1700000000,
      height: 800000,
      fee: 900,
      sat: null,
    });
    expect(parseOrdInscription(id, null)).toMatchObject({ address: null, fee: null, timestamp: null });
    const urls: string[] = [];
    const ord = createOrdApi({ baseUrl: 'https://ord.test/', network: 'signet', fetch: async (u) => (urls.push(u), jsonResponse({ id })) });
    await ord.getInscription(id);
    expect(urls).toEqual([`https://ord.test/inscription/${id}`]);
    expect(ord.contentUrl(id)).toBe(`https://ord.test/content/${id}`);
    expect(ord.inscriptionUrl(id)).toBe(`https://signet.ordinals.com/inscription/${id}`);
    expect(createOrdApi({ baseUrl: 'x' }).inscriptionUrl(id)).toBe(`https://ordinals.com/inscription/${id}`);
    await expect(ord.getInscription('nope')).rejects.toMatchObject({ status: 400 });
  });

  it('fetches each inscription once (prefetch then get), and settles failures as null', async () => {
    const site = createFakeSite();
    const cache = createDetailsCache(site.ord);
    const [a, b] = site.state.items;
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.prefetch([a!.inscriptionId, b!.inscriptionId, a!.inscriptionId]);
    expect(cache.peek(a!.inscriptionId)).toBeUndefined();
    const got = await cache.get(a!.inscriptionId);
    await cache.get(b!.inscriptionId);
    expect(got?.height).toBe(a!.height);
    expect(cache.peek(b!.inscriptionId)?.fee).toBeGreaterThan(0);
    expect(site.state.ordServed).toEqual([a!.inscriptionId, b!.inscriptionId]);
    expect(listener).toHaveBeenCalledTimes(2);
    const broken = createDetailsCache(createFakeSite({ ordFails: true }).ord);
    expect(await broken.get(a!.inscriptionId)).toBeNull();
    expect(broken.peek(a!.inscriptionId)).toBeNull();
  });
});

describe('pagination maths', () => {
  it('window: first four near the start, neighbours in the middle, last four at the end', () => {
    expect(pageWindow(1, 206)).toEqual([1, 2, 3, 4, 'gap', 206]);
    expect(pageWindow(50, 206)).toEqual([1, 'gap', 49, 50, 51, 'gap', 206]);
    expect(pageWindow(206, 206)).toEqual([1, 'gap', 203, 204, 205, 206]);
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
  });

  it('counts and ranges', () => {
    expect(pageCount(4112, 20)).toBe(206);
    expect(pageCount(0, 20)).toBe(1);
    expect(shownRange(206, 20, 4112)).toEqual({ first: 4101, last: 4112 });
    expect(shownRange(1, 20, 0)).toEqual({ first: 0, last: 0 });
  });
});
