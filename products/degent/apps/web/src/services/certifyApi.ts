/**
 * Typed client for block.space collection certification (`@bsh/blockspace-certify`, contract
 * `DegentClub/blockspace` → `contracts/openapi/blockspace-collections.yaml`). The service lives in another
 * product: this file is the front end's whole knowledge of it, and every count on the site comes
 * through it (site spec "Known defects": one source for counts).
 *
 * Endpoints used (all public, CORS-open, no credentials):
 *   GET /v1/collections/{slug}                      latest signed attestation + digest + exclusions
 *   GET /v1/collections/{slug}/items?cursor&limit   members, keyset-paged by (number, id)
 *   GET /v1/collections/{slug}/artists/{address}    members attributed to one artist (ADR-0008)
 *
 * Optional fields (`attribution`, `attributionErrors`, `Item.attribution`, and since contract 0.2.0 the
 * verified `attribution.royalty`, `royaltiesVerified`, `royaltySats`, `royaltyErrors`) are omitted, never
 * null, when absent; read them as optional. `verifiedRoyaltyOf` checks the royalty's shape.
 */

export type CertifyErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'collection_not_found'
  | 'not_certified'
  | 'artist_not_found'
  | 'refresh_in_progress'
  | 'manifest_invalid'
  | 'manifest_not_found'
  | 'parent_not_found'
  | 'upstream_error'
  | 'rate_limited'
  | 'payload_too_large'
  | 'internal_error';

export interface CollectionRef {
  slug: string;
  name: string;
  parentInscriptionId: string | null;
}

export interface ParentSource {
  type: 'parent-children';
  parentInscriptionId: string;
  pages: number;
  listed: number;
  accepted: number;
  excluded: number;
}

export interface ManifestSource {
  type: 'manifest';
  manifestInscriptionId: string | null;
  manifestSha256: string;
  /** True only when the manifest is inscribed as a child of the collection parent. */
  verified: boolean;
  listed: number;
  accepted: number;
  excluded: number;
}

export type CertifySource = ParentSource | ManifestSource;

/**
 * The output of the minter's funding transaction that paid the artist, verified by block.space from
 * chain data (contract 0.2.0, blockspace ADR-0013). Optional: older attestations never carry it.
 */
export interface VerifiedRoyalty {
  txid: string;
  vout: number;
  sats: number;
  verified: true;
}

/** Open Studio attribution read from the inscription's ord metadata. Asserted by the minter, not proven. */
export interface Attribution {
  artist: string;
  artwork: string;
  edition?: number;
  studio?: string;
  /** Present only when block.space verified the artist's royalty payment from chain data. */
  royalty?: VerifiedRoyalty;
}

export interface AttributionSummary {
  /** Distinct artist addresses among attributed members. */
  artists: number;
  /** Distinct artwork ids among attributed members. */
  artworks: number;
  /** Members per artwork id. */
  editions: Record<string, number>;
  /** Members whose royalty was verified from chain data (contract 0.2.0; omitted when none). */
  royaltiesVerified?: number;
  /** Sum of those royalty outputs, sats (present exactly when `royaltiesVerified` is). */
  royaltySats?: number;
}

export interface CollectionStats {
  itemCount: number;
  excludedCount: number;
  totalContentBytes: number;
  minItemBytes: number | null;
  maxItemBytes: number | null;
  medianItemBytes: number | null;
  firstInscriptionNumber: number | null;
  lastInscriptionNumber: number | null;
  totalRevealVbytes: number | null;
  revealTxCount: number | null;
  itemsDigest: string;
  attribution?: AttributionSummary;
  attributionErrors?: number;
  /** Royalty claims that failed verification during the refresh (contract 0.2.0; omitted when 0). */
  royaltyErrors?: number;
}

export interface Attestation {
  collection: CollectionRef;
  method: 'parent-children' | 'manifest' | 'parent-children+manifest';
  sources: CertifySource[];
  stats: CollectionStats;
  /** ord block height read at the start of the refresh; later inscriptions are excluded. */
  asOfBlockHeight: number;
  issuedAt: string;
  keyId: string;
  /** BIP340 signature over `digest`. */
  signature: string;
}

export interface Exclusion {
  inscriptionId: string;
  source: 'parent-children' | 'manifest';
  reason: 'not_found' | 'parent_link_missing' | 'after_as_of_height' | 'content_length_mismatch' | 'sha256_mismatch' | 'content_unavailable';
  detail?: string;
}

export interface CollectionResponse {
  attestation: Attestation;
  digest: string;
  exclusions: Exclusion[];
}

export interface CertifiedItem {
  inscriptionId: string;
  number: number;
  contentLength: number;
  contentType: string | null;
  /** Block height of the reveal. */
  height: number;
  sources: Array<'parent-children' | 'manifest'>;
  attribution?: Attribution;
}

export interface ItemsPage {
  slug: string;
  asOfBlockHeight: number;
  itemsDigest: string;
  items: CertifiedItem[];
  nextCursor: string | null;
}

export interface ArtistItemsPage extends ItemsPage {
  artist: string;
  /** Members attributed to this artist (all pages). */
  itemCount: number;
  /** Distinct artwork ids among them. */
  artworks: number;
  /** This artist's members with a verified royalty (contract 0.2.0; omitted when none). */
  royaltiesVerified?: number;
  royaltySats?: number;
}

export interface PageQuery {
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string | null;
  /** 1..500, service default 100. */
  limit?: number;
}

export interface CertifyApi {
  getCollection(slug: string): Promise<CollectionResponse>;
  listItems(slug: string, query?: PageQuery): Promise<ItemsPage>;
  listArtistItems(slug: string, address: string, query?: PageQuery): Promise<ArtistItemsPage>;
}

/** Largest page the contract allows. */
export const CERTIFY_MAX_LIMIT = 500;

export class CertifyApiError extends Error {
  readonly status: number;
  readonly code: CertifyErrorCode | 'network_error' | 'http_error' | 'bad_response';
  readonly requestId: string | null;
  constructor(status: number, code: CertifyApiError['code'], message: string, requestId: string | null = null) {
    super(message);
    this.name = 'CertifyApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Minimal shape checks: enough that a wrong server can never render a wrong number silently. */
function assertCollection(v: unknown): asserts v is CollectionResponse {
  const a = isObj(v) && isObj(v.attestation) ? v.attestation : null;
  const s = a && isObj(a.stats) ? a.stats : null;
  if (!a || !s || typeof s.itemCount !== 'number' || typeof s.totalContentBytes !== 'number' || typeof a.asOfBlockHeight !== 'number') {
    throw new CertifyApiError(0, 'bad_response', 'The certificate did not have the expected shape.');
  }
}

function assertItems(v: unknown): asserts v is ItemsPage {
  if (!isObj(v) || !Array.isArray(v.items) || !('nextCursor' in v)) throw new CertifyApiError(0, 'bad_response', 'The members page did not have the expected shape.');
}

export function createCertifyApi(opts: { baseUrl: string; fetch?: FetchLike }): CertifyApi {
  const f: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (e) {
      throw new CertifyApiError(0, 'network_error', `block.space could not be reached: ${e instanceof Error ? e.message : String(e)}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = isObj(body) && isObj(body.error) ? body.error : null;
      if (err && typeof err.code === 'string') {
        throw new CertifyApiError(res.status, err.code as CertifyErrorCode, String(err.message ?? err.code), typeof err.requestId === 'string' ? err.requestId : null);
      }
      throw new CertifyApiError(res.status, 'http_error', `block.space request failed (HTTP ${res.status})`);
    }
    return body;
  }

  const slugPath = (slug: string) => {
    if (!SLUG.test(slug)) throw new CertifyApiError(400, 'bad_request', `Not a collection slug: ${slug}`);
    return `/v1/collections/${slug}`;
  };
  const q = (query?: PageQuery): string => {
    const p = new URLSearchParams();
    if (query?.cursor) p.set('cursor', query.cursor);
    if (query?.limit !== undefined) p.set('limit', String(Math.max(1, Math.min(CERTIFY_MAX_LIMIT, Math.floor(query.limit)))));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    async getCollection(slug) {
      const body = await get(slugPath(slug));
      assertCollection(body);
      return body;
    },
    async listItems(slug, query) {
      const body = await get(`${slugPath(slug)}/items${q(query)}`);
      assertItems(body);
      return body;
    },
    async listArtistItems(slug, address, query) {
      const body = await get(`${slugPath(slug)}/artists/${encodeURIComponent(address)}${q(query)}`);
      assertItems(body);
      return body as ArtistItemsPage;
    },
  };
}

const HEX32 = /^[0-9a-f]{64}$/;

/** A member's verified royalty, or null when absent or malformed (never trust a half-shaped claim). */
export function verifiedRoyaltyOf(item: Pick<CertifiedItem, 'attribution'>): VerifiedRoyalty | null {
  const r = item.attribution?.royalty as Partial<VerifiedRoyalty> | undefined;
  if (!r || r.verified !== true || typeof r.txid !== 'string' || !HEX32.test(r.txid)) return null;
  if (!Number.isSafeInteger(r.vout) || (r.vout as number) < 0 || !Number.isSafeInteger(r.sats) || (r.sats as number) < 0) return null;
  return { txid: r.txid, vout: r.vout as number, sats: r.sats as number, verified: true };
}
