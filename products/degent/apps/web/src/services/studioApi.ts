/**
 * Typed client for the Artist Studio HTTP API (contracts/openapi/degent-studio.yaml). The studio is
 * a service, not a library: this file is the front end's whole knowledge of it. Types mirror the
 * contract's schemas; fields the contract does not (yet) carry are optional and read defensively.
 *
 * Auth: the artist session JWT (`POST /v1/auth/verify`) and the one-time upload token both travel
 * as `Authorization: Bearer …`, never in a URL. Errors surface as `StudioApiError` with the
 * contract's `error.code`.
 */
import type { Network } from '@bsh/degent-mint-sdk';

export type ArtworkStatus = 'submitted' | 'reviewing' | 'approved' | 'rejected' | 'delisted';

export interface StudioRule {
  id: 'format' | 'square' | 'design' | 'framing' | 'quantity';
  title: string;
  text: string;
  check: 'automated' | 'vision' | 'both';
}

export interface StudioConfig {
  network: Network;
  rulesVersion: string;
  rules: StudioRule[];
  recommendedContentType: string;
  allowedContentTypes: string[];
  tiers: Array<{ tier: 'standard' | 'large' | 'fullblock'; label: string; minBytes: number; maxBytes: number }>;
  minDimensionPx: number;
  maxDimensionPx: number;
  maxUploadBytes: number;
  titleMaxChars: number;
  descriptionMaxChars: number;
  displayNameMaxChars: number;
  siwb: { domain: string; uri: string; ttlSeconds: number };
  session: { ttlSeconds: number; audience: string; scopes: string[] };
  payoutMessageTemplate: string;
  payoutAddressKinds: Array<'p2wpkh' | 'p2tr'>;
  visionReview: 'claude' | 'none';
  /** ADR-0012 (optional: older studios omit them). Largest accepted `maxEditions`. */
  maxEditionsLimit?: number;
  featuredRankMax?: number;
  appealMessageMaxChars?: number;
  /** Appeals allowed per artwork over its lifetime. */
  appealsPerArtwork?: number;
  /** `webhook` always; `telegram` when the studio has a bot. */
  notifyChannels?: string[];
}

export interface ChallengeResponse {
  message: string;
  nonce: string;
  address: string;
  network: Network;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifyRequest {
  message: string;
  /** base64: BIP-322 simple witness, or a 65-byte legacy signmessage signature. */
  signature: string;
  address: string;
}

/** Where the studio notifies the artist (ADR-0012 §6). The secret itself is never returned again. */
export interface ArtistNotify {
  webhookUrl: string | null;
  telegramChatId: string | null;
  webhookSecretSet: boolean;
}

export interface StudioArtist {
  address: string;
  network: Network;
  displayName: string | null;
  payoutAddress: string | null;
  payoutVerifiedAt: string | null;
  artworks: { total: number; approved: number };
  joinedAt: string;
  updatedAt: string;
  /** ADR-0012; optional (older studios omit it). */
  notify?: ArtistNotify;
  /**
   * The webhook signing secret: ONLY in the `PUT /v1/artists/me` response that generated it (first webhook or
   * `rotateWebhookSecret`). Shown to the artist once, never stored by the app.
   */
  notifyWebhookSecret?: string;
}

export interface SessionResponse {
  token: string;
  expiresAt: string;
  method: 'bip322-simple' | 'legacy';
  artist: StudioArtist;
}

export interface NotifyUpdate {
  /** https URL; null clears it (and deletes the secret); omitted = unchanged. */
  webhookUrl?: string | null;
  /** Numeric chat id or @channel; null clears it. */
  telegramChatId?: string | null;
  /** Generate a new signing secret (returned once). */
  rotateWebhookSecret?: boolean;
}

export interface UpdateArtistRequest {
  displayName?: string | null;
  payout?: { address: string; signature: string };
  /** Null clears both targets. */
  notify?: NotifyUpdate | null;
}

export interface StudioPublicArtist {
  address: string;
  displayName: string | null;
  artworks: number;
  joinedAt: string;
}

export interface StudioReviewCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface AutomatedReview {
  approved: boolean;
  needsHuman: boolean;
  reasons: string[];
  checks: StudioReviewCheck[];
  reviewer: string;
}

export interface HouseReview {
  decision: 'approve' | 'reject';
  reasons: string[];
  reviewerId: string;
  at: string;
}

export interface ArtworkReview {
  automated: AutomatedReview | null;
  house: HouseReview | null;
  reviewedAt: string;
}

export type AppealStatus = 'open' | 'granted' | 'denied';

/** A rejected artwork's appeal to a human (ADR-0012 §5). Shown to the owner only. */
export interface Appeal {
  id: string;
  artworkId: string;
  artist: string;
  message: string;
  status: AppealStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolution: HouseReview | null;
}

export interface AppealResponse {
  appeal: Appeal;
  artwork: StudioArtwork;
}

export interface ArtworkEvent {
  status: ArtworkStatus;
  at: string;
  detail?: string;
}

export interface StudioArtwork {
  id: string;
  /** Artist address. */
  artist: string;
  network: Network;
  title: string;
  description: string | null;
  contentType: string;
  contentLength: number;
  /** Null until the bytes are uploaded. */
  contentSha256: string | null;
  status: ArtworkStatus;
  needsHuman: boolean;
  review: ArtworkReview | null;
  featured: boolean;
  featuredAt: string | null;
  /** `/v1/artworks/{id}/content` while approved, else null. */
  contentUrl: string | null;
  timeline: ArtworkEvent[];
  createdAt: string;
  updatedAt: string;
  /** Editions minted so far (royalty records; ADR-0012). Optional: older studios omit it. */
  mintedEditions?: number;
  /** Edition cap (1-10000); null or absent = open edition (ADR-0012). */
  maxEditions?: number | null;
  /** The cap is reached; the mint refuses new orders (ADR-0012). */
  soldOut?: boolean;
  /** House curation order, lower first (ADR-0012 §4). */
  featuredRank?: number | null;
  /** The artist's appeals, oldest first (owner only). */
  appeals?: Appeal[];
}

/**
 * Edition facts read defensively (every field is optional on the wire): `soldOut` from the studio when it
 * says so, else derived from `mintedEditions >= maxEditions`.
 */
export function editionsOf(w: Pick<StudioArtwork, 'mintedEditions' | 'maxEditions' | 'soldOut'>): { minted: number | null; max: number | null; soldOut: boolean } {
  const minted = typeof w.mintedEditions === 'number' && Number.isSafeInteger(w.mintedEditions) && w.mintedEditions >= 0 ? w.mintedEditions : null;
  const max = typeof w.maxEditions === 'number' && Number.isSafeInteger(w.maxEditions) && w.maxEditions >= 1 ? w.maxEditions : null;
  const soldOut = w.soldOut === true || (max !== null && minted !== null && minted >= max);
  return { minted, max, soldOut };
}

/** The newest appeal on an artwork, if any. */
export function latestAppeal(w: Pick<StudioArtwork, 'appeals'>): Appeal | null {
  const list = Array.isArray(w.appeals) ? w.appeals : [];
  return list.length > 0 ? list[list.length - 1]! : null;
}

export interface CreateArtworkRequest {
  title: string;
  description?: string;
  contentType: string;
  contentLength: number;
  /** 1-10000; omitted or null = open edition (ADR-0012). */
  maxEditions?: number | null;
}

export interface CreateArtworkResponse {
  artwork: StudioArtwork;
  /** 256-bit base64url bearer secret, returned once. */
  uploadToken: string;
}

export interface ArtworkList {
  items: StudioArtwork[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ArtworkQuery {
  status?: ArtworkStatus;
  artist?: string;
  /** true: only mintable (not sold out); false: only sold out (ADR-0012). */
  available?: boolean;
  page?: number;
  pageSize?: number;
}

export interface RoyaltyRecord {
  orderId: string;
  artworkId: string;
  artist: string;
  minterAddress: string | null;
  royaltySats: number;
  fundingTxid: string;
  vout: number;
  at: string;
  recordedAt: string;
  /** The edition number the mint assigned (ADR-0012; optional). */
  edition?: number;
}

export interface RoyaltiesResponse {
  items: RoyaltyRecord[];
  totals: { records: number; royaltySats: number };
  page: number;
  pageSize: number;
  total: number;
}

export interface ArtworkContent {
  bytes: Uint8Array;
  contentType: string;
  /** From the ETag when the server sends one. */
  sha256: string | null;
}

export interface StudioApi {
  getConfig(): Promise<StudioConfig>;
  /** POST /v1/auth/challenge */
  challenge(address: string, network: Network): Promise<ChallengeResponse>;
  /** POST /v1/auth/verify */
  verify(req: VerifyRequest): Promise<SessionResponse>;
  getMe(token: string): Promise<StudioArtist>;
  updateMe(token: string, req: UpdateArtistRequest): Promise<StudioArtist>;
  getMyRoyalties(token: string, page?: number, pageSize?: number): Promise<RoyaltiesResponse>;
  getArtist(address: string): Promise<StudioPublicArtist>;
  /** GET /v1/artworks — `status` other than approved needs the owner's session. */
  listArtworks(query: ArtworkQuery, token?: string): Promise<ArtworkList>;
  getArtwork(id: string, token?: string): Promise<StudioArtwork>;
  createArtwork(token: string, req: CreateArtworkRequest): Promise<CreateArtworkResponse>;
  /** PUT /v1/artworks/{id}/content (octet-stream, upload token): the review runs once, here. */
  uploadContent(id: string, uploadToken: string, bytes: Uint8Array): Promise<StudioArtwork>;
  /** GET /v1/artworks/{id}/content: the exact bytes of an approved artwork. */
  getContent(id: string): Promise<ArtworkContent>;
  /** URL of the approved bytes, for <img>. */
  contentUrl(id: string): string;
  /** DELETE /v1/artworks/{id}: the artist delists an approved artwork. */
  delist(id: string, token: string): Promise<StudioArtwork>;
  /** PUT /v1/artworks/{id}/editions: set, raise, open (null) or lower (not below minted) the cap. */
  setEditions(id: string, token: string, maxEditions: number | null): Promise<StudioArtwork>;
  /** POST /v1/artworks/{id}/appeal: ask the house to look at a rejection again. */
  appeal(id: string, token: string, message: string): Promise<AppealResponse>;
}

export class StudioApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'StudioApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function isErrorBody(v: unknown): v is ErrorBody {
  return typeof v === 'object' && v !== null && 'error' in v && typeof (v as ErrorBody).error?.code === 'string';
}

export function createStudioApi(opts: { baseUrl: string; fetch?: FetchLike }): StudioApi {
  const f: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function raw(method: string, path: string, body?: { json: unknown } | { bytes: Uint8Array }, token?: string): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body && 'json' in body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body && 'bytes' in body) {
      headers['content-type'] = 'application/octet-stream';
      payload = body.bytes.slice();
    }
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
    } catch (e) {
      throw new StudioApiError(0, 'network_error', `The studio could not be reached: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      if (isErrorBody(parsed)) throw new StudioApiError(res.status, parsed.error.code, parsed.error.message, parsed.error.details);
      throw new StudioApiError(res.status, 'http_error', `Studio request failed (HTTP ${res.status})`);
    }
    return res;
  }

  async function call<T>(method: string, path: string, body?: { json: unknown } | { bytes: Uint8Array }, token?: string): Promise<T> {
    const res = await raw(method, path, body, token);
    return (await res.json()) as T;
  }

  const q = (query: Record<string, string | number | undefined>): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    getConfig: () => call('GET', '/v1/config'),
    challenge: (address, network) => call('POST', '/v1/auth/challenge', { json: { address, network } }),
    verify: (req) => call('POST', '/v1/auth/verify', { json: req }),
    getMe: (token) => call('GET', '/v1/artists/me', undefined, token),
    updateMe: (token, req) => call('PUT', '/v1/artists/me', { json: req }, token),
    getMyRoyalties: (token, page, pageSize) => call('GET', `/v1/artists/me/royalties${q({ page, pageSize })}`, undefined, token),
    getArtist: (address) => call('GET', `/v1/artists/${encodeURIComponent(address)}`),
    listArtworks: (query, token) =>
      call(
        'GET',
        `/v1/artworks${q({ status: query.status, artist: query.artist, available: query.available === undefined ? undefined : String(query.available), page: query.page, pageSize: query.pageSize })}`,
        undefined,
        token,
      ),
    getArtwork: (id, token) => call('GET', `/v1/artworks/${encodeURIComponent(id)}`, undefined, token),
    createArtwork: (token, req) => call('POST', '/v1/artworks', { json: req }, token),
    uploadContent: (id, uploadToken, bytes) => call('PUT', `/v1/artworks/${encodeURIComponent(id)}/content`, { bytes }, uploadToken),
    async getContent(id) {
      const res = await raw('GET', `/v1/artworks/${encodeURIComponent(id)}/content`);
      const etag = res.headers.get('etag');
      const m = etag ? /^"?([0-9a-f]{64})"?$/.exec(etag.trim()) : null;
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        contentType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim(),
        sha256: m ? m[1]! : null,
      };
    },
    contentUrl: (id) => `${base}/v1/artworks/${encodeURIComponent(id)}/content`,
    delist: (id, token) => call('DELETE', `/v1/artworks/${encodeURIComponent(id)}`, undefined, token),
    setEditions: (id, token, maxEditions) => call('PUT', `/v1/artworks/${encodeURIComponent(id)}/editions`, { json: { maxEditions } }, token),
    appeal: (id, token, message) => call('POST', `/v1/artworks/${encodeURIComponent(id)}/appeal`, { json: { message } }, token),
  };
}
