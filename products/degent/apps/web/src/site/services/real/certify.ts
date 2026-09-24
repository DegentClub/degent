/**
 * block.space certification API client (`@bsh/blockspace-certify`, contract owned by
 * DegentClub/blockspace). The site reads exactly two endpoints:
 *
 *   GET {base}/v1/collections/{slug}                 → the collection with its latest attestation
 *   GET {base}/v1/collections/{slug}/items?cursor=   → the certified membership list, paginated
 *
 * The response shapes are parsed defensively (snake_case or camelCase, stats nested under the
 * attestation or at the top level) because the contract is not vendored in this repository; the
 * accepted shapes are listed in the README ("Certification API"). Anything unparseable is an error,
 * never a guess: the UI then shows "unavailable" instead of a number.
 */
import type { CollectionItem, CollectionList, CollectionService, CollectionStats, StatsService } from '../types';
import { COLLECTION_SUPPLY, bundledStats, loadBundledCollection } from '../bundled';

type Json = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function str(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return null;
}

export class CertifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertifyError';
  }
}

/** Parse `GET /v1/collections/{slug}` into stats. Throws CertifyError when the counts are missing. */
export function parseCollectionAttestation(body: unknown): CollectionStats {
  if (!isObj(body)) throw new CertifyError('certification response is not an object');
  const col = isObj(body.collection) ? body.collection : body;
  const att = isObj(col.attestation) ? col.attestation : isObj(col.latestAttestation) ? col.latestAttestation : col;
  const stats = isObj(att.stats) ? att.stats : isObj(col.stats) ? col.stats : att;
  const minted = num(stats.count, stats.items, stats.members, stats.minted, stats.item_count, stats.itemCount);
  const bytes = num(stats.total_bytes, stats.totalBytes, stats.content_bytes, stats.contentBytes, stats.bytes);
  if (minted === null || bytes === null) throw new CertifyError('certification response has no item count or byte total');
  const supply = num(col.supply, col.max_supply, col.maxSupply, stats.supply) ?? COLLECTION_SUPPLY;
  const height = num(att.height, att.block_height, att.blockHeight, att.certified_height, att.certifiedHeight);
  const at = str(att.issued_at, att.issuedAt, att.certified_at, att.certifiedAt, att.time);
  return { source: 'certified', supply, minted, bytes, certifiedHeight: height, certifiedAt: at };
}

/** Parse one page of `GET /v1/collections/{slug}/items`. */
export function parseItemsPage(body: unknown): { items: CollectionItem[]; next: string | null } {
  if (!isObj(body) || !Array.isArray(body.items)) throw new CertifyError('items response has no items array');
  const items: CollectionItem[] = [];
  for (const raw of body.items) {
    if (!isObj(raw)) continue;
    const id = str(raw.inscription_id, raw.inscriptionId, raw.id);
    const n = num(raw.number, raw.collection_number, raw.collectionNumber, raw.index);
    if (!id || n === null) continue;
    const len = num(raw.content_length, raw.contentLength, raw.size);
    const kb = num(raw.size_kb) ?? (len !== null ? len / 1000 : null);
    items.push({ id, number: n, name: str(raw.name) ?? `Degent #${n}`, ...(kb !== null ? { size_kb: kb } : {}) });
  }
  const next = str(body.next_cursor, body.nextCursor, body.cursor_next, isObj(body.page) ? body.page.next : null);
  return { items, next };
}

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new CertifyError(`certification API ${res.status}`);
  return res.json();
}

export interface CertifyOptions {
  baseUrl: string;
  slug: string;
  fetch?: FetchLike;
  /** Safety cap on followed cursors. */
  maxPages?: number;
}

/**
 * StatsService over the certification API. With no base URL (not configured) it reports an error
 * instead of numbers, unless `fallbackToBundled` (demo) is set.
 */
export function createCertifiedStats(opts: CertifyOptions & { fallbackToBundled?: boolean }): StatsService {
  const fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  let cached: Promise<CollectionStats> | null = null;
  return {
    getStats() {
      cached ??= (async () => {
        if (!opts.baseUrl) {
          if (opts.fallbackToBundled) return bundledStats();
          throw new CertifyError('certification API not configured');
        }
        try {
          return parseCollectionAttestation(await getJson(fetchFn, `${opts.baseUrl}/v1/collections/${opts.slug}`));
        } catch (e) {
          if (opts.fallbackToBundled) return bundledStats();
          throw e;
        }
      })();
      cached.catch(() => (cached = null));
      return cached;
    },
  };
}

/**
 * Membership: the certified items list (all pages), falling back to the bundled snapshot when the
 * API is not configured or fails. The fallback is labelled `source: 'bundled'`.
 */
export function createCertifiedCollection(opts: CertifyOptions): CollectionService {
  const fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  let cached: Promise<CollectionList> | null = null;
  const loadCertified = async (): Promise<CollectionItem[]> => {
    const all: CollectionItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < (opts.maxPages ?? 500); page++) {
      const url = `${opts.baseUrl}/v1/collections/${opts.slug}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { items, next } = parseItemsPage(await getJson(fetchFn, url));
      all.push(...items);
      if (!next || next === cursor) break;
      cursor = next;
    }
    if (all.length === 0) throw new CertifyError('certified membership is empty');
    return all.sort((a, b) => a.number - b.number);
  };
  return {
    list() {
      cached ??= (async (): Promise<CollectionList> => {
        if (opts.baseUrl) {
          try {
            return { source: 'certified', items: await loadCertified() };
          } catch {
            /* fall through to the bundled snapshot */
          }
        }
        return { source: 'bundled', items: await loadBundledCollection() };
      })();
      return cached;
    },
  };
}
