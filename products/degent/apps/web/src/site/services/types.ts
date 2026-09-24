/**
 * Ports for the degent.club site (everything outside the /mint wizard). Real adapters live in
 * `./real/*`, fakes in `./fakes.ts` (tests and `?demo=1`, no network).
 */
import type { Tier } from '@bsh/degent-mint-sdk';

// ---------------------------------------------------------------- stats (block.space certification)

/**
 * Collection stats. ONE source: the block.space certification attestation. In demo mode (or when a
 * deployment has no certification URL) the bundled manifest summary stands in, labelled as such.
 */
export interface CollectionStats {
  source: 'certified' | 'bundled';
  /** Target supply of the collection. */
  supply: number;
  /** Members counted by the attestation (or the bundled manifest). */
  minted: number;
  /** Sum of the members' content bytes. */
  bytes: number;
  /** Block height the attestation certifies (certified only). */
  certifiedHeight: number | null;
  /** When the attestation was issued, ISO 8601 (certified only). */
  certifiedAt: string | null;
}

export interface StatsService {
  getStats(): Promise<CollectionStats>;
}

// ---------------------------------------------------------------- collection membership

export interface CollectionItem {
  /** Inscription id (`<txid>i<n>`). */
  id: string;
  /** Collection number (Degent #N). */
  number: number;
  name: string;
  /** Content size in kB, when known. */
  size_kb?: number;
}

export interface CollectionList {
  source: 'certified' | 'bundled';
  items: CollectionItem[];
}

export interface CollectionService {
  /** The whole membership list, sorted by number (cached after the first call). */
  list(): Promise<CollectionList>;
}

// ---------------------------------------------------------------- ord

export interface InscriptionDetails {
  id: string;
  number: number | null;
  address: string | null;
  contentType: string | null;
  contentLength: number | null;
  /** ISO 8601 */
  timestamp: string | null;
  height: number | null;
  /** sats */
  fee: number | null;
}

export interface OrdService {
  /** ord `GET /inscription/{id}` (JSON). Cached; concurrent calls share one request. */
  getInscription(id: string): Promise<InscriptionDetails>;
  /** Warm the cache without surfacing errors. */
  prefetch(id: string): void;
  /** ord `GET /address/{address}` (JSON): inscription ids held by the address. */
  getAddressInscriptions(address: string): Promise<string[]>;
  contentUrl(id: string): string;
  /** Human page on the ord explorer. */
  inscriptionUrl(id: string): string;
}

// ---------------------------------------------------------------- newsletter

export interface NewsletterRequest {
  name: string;
  email: string;
}

export type NewsletterResult = { ok: true; alreadySubscribed: boolean } | { ok: false; message: string };

export interface NewsletterService {
  readonly configured: boolean;
  subscribe(req: NewsletterRequest): Promise<NewsletterResult>;
}

// ---------------------------------------------------------------- atelier (contracts/openapi/degent-atelier.yaml)

export type Placard = 'DEGEN' | 'DEGENT' | 'REGEN';
export const PLACARDS: readonly Placard[] = ['DEGEN', 'DEGENT', 'REGEN'];

export interface AtelierQuota {
  dailyImages: number;
  usedToday: number;
}

export interface AtelierHealth {
  status: 'ok' | 'degraded';
  provider: { name: string; mode: 'fake' | 'live' };
  queueDepth: number;
  spentTodayCents: number;
  dailyCostCapCents: number;
}

export interface AtelierConfig {
  tiers: Array<{ tier: Tier; label: string; minBytes: number; maxBytes: number }>;
  placards: Placard[];
  maxVariations: number;
  maxUploadBytes: number;
  sessionDailyImages: number;
}

export interface ReviewCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface AtelierReview {
  approved: boolean;
  reasons: string[];
  checks: ReviewCheck[];
}

export interface AtelierCandidate {
  id: string;
  previewUrl: string;
  width: number;
  height: number;
  providerRef: string;
  review: AtelierReview | null;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AtelierJob {
  id: string;
  status: JobStatus;
  tier: Tier;
  placard: Placard;
  brief: string;
  variations: number;
  provider: string;
  error: { code: 'provider_unavailable' | 'job_failed'; message: string } | null;
  candidates: AtelierCandidate[];
}

export interface GenerateRequest {
  brief: string;
  palette?: string | null;
  mood?: string | null;
  placard: Placard;
  tier: Tier;
  variations: number;
  seed?: number;
}

export interface FinalizedContent {
  tier: Tier;
  placard: Placard | null;
  contentSha256: string;
  contentLength: number;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  review: AtelierReview;
  downloadUrl: string;
  /** Upload only: false when the upload was stored byte-for-byte. */
  transformed?: boolean;
}

/** Contract error codes the UI renders specifically. */
export type AtelierErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'not_found'
  | 'quota_exceeded'
  | 'cost_cap_reached'
  | 'job_failed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'range_unreachable'
  | 'provider_unavailable'
  | 'review_rejected'
  | 'rate_limited'
  | 'not_configured'
  | 'network'
  | string;

export class AtelierError extends Error {
  constructor(
    readonly code: AtelierErrorCode,
    message: string,
    readonly status = 0,
    readonly retryAfterSeconds: number | null = null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AtelierError';
  }
}

export interface AtelierService {
  readonly configured: boolean;
  health(): Promise<AtelierHealth>;
  config(): Promise<AtelierConfig>;
  /** Creates an anonymous session on first use; returns the current quota. */
  ensureSession(): Promise<AtelierQuota>;
  generate(req: GenerateRequest): Promise<{ jobId: string; quota: AtelierQuota }>;
  getJob(jobId: string): Promise<AtelierJob>;
  finalize(candidateId: string, req: { tier: Tier; placard: Placard }): Promise<FinalizedContent>;
  upload(file: Blob, opts: { tier: Tier; placard: Placard | null; frame: boolean }): Promise<FinalizedContent>;
  /** `GET /v1/content/{sha256}`: the exact bytes to mint. */
  getContent(sha256: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------- bundle

export interface SiteServices {
  mode: 'live' | 'demo';
  stats: StatsService;
  collection: CollectionService;
  ord: OrdService;
  newsletter: NewsletterService;
  atelier: AtelierService;
}
