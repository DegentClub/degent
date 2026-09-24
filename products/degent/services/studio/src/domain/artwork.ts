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
}

/**
 * Allowed transitions (ADR-0007 §3). `submitted -> reviewing` happens on upload; `reviewing` resolves to
 * `approved` / `rejected` automatically or by the house; the artist can delist an approved piece; the house
 * can take down (`approved -> rejected`) or reinstate (`rejected -> approved`). `delisted` is terminal.
 */
export const TRANSITIONS: Readonly<Record<ArtworkStatus, readonly ArtworkStatus[]>> = Object.freeze({
  submitted: ['reviewing'],
  reviewing: ['approved', 'rejected'],
  approved: ['rejected', 'delisted'],
  rejected: ['approved'],
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

export function toPublicArtwork(r: ArtworkRecord, contentUrl: (id: string) => string): Artwork {
  return {
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
  };
}
