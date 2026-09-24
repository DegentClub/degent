/**
 * The Artist Studio as the mint sees it (contracts/openapi/degent-studio.yaml, ADR-0007). Read-only for
 * artworks and bytes; one write: the royalty record after a verified funding transaction (plan §3.3).
 */
export type StudioArtworkStatus = 'submitted' | 'reviewing' | 'approved' | 'rejected' | 'delisted';

export interface StudioArtwork {
  id: string;
  /** The artist's identity: the address that signed in. */
  artist: string;
  /** The artist's BIP-322-proven payout address (ADR-0007 §3); null until proven. */
  payoutAddress: string | null;
  title: string;
  contentType: string;
  contentLength: number;
  /** Null until the bytes were uploaded. */
  contentSha256: string | null;
  status: StudioArtworkStatus;
}

/** Body of `POST /v1/internal/royalties` (RoyaltyRecordRequest). Idempotent on `orderId`. */
export interface RoyaltyRecordRequest {
  orderId: string;
  artworkId: string;
  minterAddress: string | null;
  royaltySats: number;
  fundingTxid: string;
  vout: number;
  at: string;
}

/** Thrown by adapters; `retryable` says whether the worker should try again later. */
export class StudioClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'StudioClientError';
  }
}

export interface StudioClient {
  readonly name: string;
  /** Null when the studio has no such artwork. Throws StudioClientError when the studio is unreachable. */
  getArtwork(id: string): Promise<StudioArtwork | null>;
  /** The exact approved bytes (`GET /v1/artworks/{id}/content`); null when not served. */
  getContent(id: string): Promise<Uint8Array | null>;
  /** Records the royalty; `created: false` on an idempotent replay. Throws StudioClientError otherwise. */
  postRoyalty(record: RoyaltyRecordRequest): Promise<{ created: boolean }>;
}
