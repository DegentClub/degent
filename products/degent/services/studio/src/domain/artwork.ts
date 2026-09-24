/**
 * Artwork aggregate: the record the stores persist, the allowed-transitions table and the public
 * view (contracts/openapi/degent-studio.yaml `Artwork`). Never expose `uploadTokenHash` or `version`.
 */
import type { Network, ReviewCheck } from '@bsh/degent-mint-sdk';
import { DomainError } from './errors.js';

export const ARTWORK_STATUSES = ['submitted', 'reviewing', 'approved', 'rejected', 'delisted'] as const;
export type ArtworkStatus = (typeof ARTWORK_STATUSES)[number];

export const TITLE_MAX_CHARS = 80;
export const DESCRIPTION_MAX_CHARS = 500;
/** Largest accepted `maxEditions` (ADR-0012). */
export const MAX_EDITIONS_LIMIT = 10_000;
/** Largest accepted `featuredRank`. */
export const FEATURED_RANK_MAX = 1_000;
export const APPEAL_MESSAGE_MAX_CHARS = 1_000;
/** Appeals an artwork may receive over its lifetime (one open at a time). */
export const APPEALS_PER_ARTWORK = 3;

export const APPEAL_STATUSES = ['open', 'granted', 'denied'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

/** An artist's request for a human review of a rejection (ADR-0012). Stored on the artwork record. */
export interface AppealRecord {
  /** `<artworkId>:appeal:<n>` (1-based per artwork). */
  id: string;
  artworkId: string;
  artist: string;
  message: string;
  status: AppealStatus;
  createdAt: string;
  resolvedAt: string | null;
  /** The house verdict that resolved it. */
  resolution: HouseReview | null;
}

export interface AutomatedReview {
  approved: boolean;
  /** True when a check was skipped: the artwork waits for the house instead of being auto-approved. */
  needsHuman: boolean;
  reasons: string[];
  checks: ReviewCheck[];
  reviewer: string;
}

export interface HouseReview {
  decision: 'approve' | 'reject';
  reasons: string[];
  /** API key id of the reviewer (never the key). */
  reviewerId: string;
  at: string;
}

export interface ArtworkReview {
  automated: AutomatedReview | null;
  house: HouseReview | null;
  reviewedAt: string;
}

export interface ArtworkEvent {
  status: ArtworkStatus;
  at: string;
  detail?: string;
}

export interface ArtworkRecord {
  id: string;
  artist: string;
  network: Network;
  title: string;
  description: string | null;
  contentType: string;
  contentLength: number;
  contentSha256: string | null;
  status: ArtworkStatus;
  needsHuman: boolean;
  review: ArtworkReview | null;
  featured: boolean;
  featuredAt: string | null;
  timeline: ArtworkEvent[];
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency version (stores bump it on save). */
  version: number;
  /** SHA-256 hex of the one-time upload token. */
  uploadTokenHash: string;
  // ADR-0012 fields. Optional so rows written before them read as an open edition, unranked, never appealed.
  /** Edition cap; null / absent = open edition. */
  maxEditions?: number | null;
  /** Royalty records received for this artwork (one per minted edition). */
  mintedEditions?: number;
  /** House curation order, lower first; only while featured. */
  featuredRank?: number | null;
  /** Oldest first; at most one `open`. */
  appeals?: AppealRecord[];
}

/** Public view: the record without secrets or storage bookkeeping, plus the content URL. */
export interface Artwork {
  id: string;
  artist: string;
  network: Network;
  title: string;
  description: string | null;
  contentType: string;
  contentLength: number;
  contentSha256: string | null;
  status: ArtworkStatus;
  needsHuman: boolean;
  review: ArtworkReview | null;
  featured: boolean;
  featuredAt: string | null;
  contentUrl: string | null;
  timeline: ArtworkEvent[];
  createdAt: string;
  updatedAt: string;
  maxEditions: number | null;
  mintedEditions: number;
  soldOut: boolean;
  featuredRank: number | null;
  /** Owner and API-key viewers only. */
  appeals?: AppealRecord[];
}

/**
 * Allowed transitions (ADR-0007 §3, ADR-0012). `submitted -> reviewing` happens on upload; `reviewing` resolves
 * to `approved` / `rejected` automatically or by the house; the artist can delist an approved piece; the house
 * can take down (`approved -> rejected`) or reinstate (`rejected -> approved`); the artist can appeal a
 * rejection (`rejected -> reviewing`, needsHuman). `delisted` is terminal.
 */
export const TRANSITIONS: Readonly<Record<ArtworkStatus, readonly ArtworkStatus[]>> = Object.freeze({
  submitted: ['reviewing'],
  reviewing: ['approved', 'rejected'],
  approved: ['rejected', 'delisted'],
  rejected: ['approved', 'reviewing'],
  delisted: [],
});

export function canTransition(from: ArtworkStatus, to: ArtworkStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isArtworkStatus(v: unknown): v is ArtworkStatus {
  return typeof v === 'string' && (ARTWORK_STATUSES as readonly string[]).includes(v);
}

/** Apply a transition to a copy of the record (throws 409 `illegal_transition` when the table forbids it). */
export function transition(r: ArtworkRecord, to: ArtworkStatus, at: string, detail?: string): ArtworkRecord {
  if (!canTransition(r.status, to))
    throw new DomainError('illegal_transition', 409, `artwork is ${r.status}; cannot become ${to}`, { status: r.status, to });
  const event: ArtworkEvent = detail === undefined ? { status: to, at } : { status: to, at, detail };
  return { ...r, status: to, updatedAt: at, timeline: [...r.timeline, event] };
}

export const ARTWORK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True when the artwork has a cap and the minted editions reached it (ADR-0012). */
export function isSoldOut(r: Pick<ArtworkRecord, 'maxEditions' | 'mintedEditions'>): boolean {
  return r.maxEditions != null && (r.mintedEditions ?? 0) >= r.maxEditions;
}

export function openAppeal(r: Pick<ArtworkRecord, 'appeals'>): AppealRecord | null {
  return r.appeals?.find((a) => a.status === 'open') ?? null;
}

/**
 * Public view. `includePrivate` (the owner or an API key) adds the appeals: the artist's messages to the
 * house are not for the public gallery.
 */
export function toPublicArtwork(r: ArtworkRecord, contentUrl: (id: string) => string, includePrivate = false): Artwork {
  const view: Artwork = {
    id: r.id,
    artist: r.artist,
    network: r.network,
    title: r.title,
    description: r.description,
    contentType: r.contentType,
    contentLength: r.contentLength,
    contentSha256: r.contentSha256,
    status: r.status,
    needsHuman: r.needsHuman,
    review: r.review ? structuredClone(r.review) : null,
    featured: r.featured,
    featuredAt: r.featuredAt,
    contentUrl: r.status === 'approved' ? contentUrl(r.id) : null,
    timeline: r.timeline.map((e) => ({ ...e })),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    maxEditions: r.maxEditions ?? null,
    mintedEditions: r.mintedEditions ?? 0,
    soldOut: isSoldOut(r),
    featuredRank: r.featuredRank ?? null,
  };
  if (includePrivate) view.appeals = (r.appeals ?? []).map((a) => structuredClone(a));
  return view;
}
