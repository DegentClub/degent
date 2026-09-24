import type { ArtworkCounts } from '../domain/artist.js';
import type { AppealRecord, AppealStatus, ArtworkRecord, ArtworkStatus } from '../domain/artwork.js';

export interface ArtworkQuery {
  status?: ArtworkStatus;
  artist?: string;
  /** true: only artworks that are not sold out; false: only sold-out ones (ADR-0012). */
  available?: boolean;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface ArtworkPage {
  items: ArtworkRecord[];
  total: number;
}

export interface AppealQuery {
  status?: AppealStatus;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface AppealPage {
  items: AppealRecord[];
  total: number;
}

/**
 * Persistence for artworks. Optimistic writes like ArtistStore. `list` is the gallery order: `featuredRank`
 * ascending (featured and ranked first, unranked last), then featured, then newest (createdAt desc, id desc).
 * Appeals live on their artwork record (so a transition and its appeal are one write); `listAppeals` is the
 * house queue across artworks, oldest first (createdAt asc, id asc).
 */
export interface ArtworkStore {
  create(record: ArtworkRecord): Promise<void>;
  get(id: string): Promise<ArtworkRecord | null>;
  save(record: ArtworkRecord): Promise<ArtworkRecord>;
  list(query: ArtworkQuery): Promise<ArtworkPage>;
  countByArtist(address: string): Promise<ArtworkCounts>;
  listAppeals(query: AppealQuery): Promise<AppealPage>;
}
