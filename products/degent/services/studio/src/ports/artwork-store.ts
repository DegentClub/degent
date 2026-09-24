import type { ArtworkCounts } from '../domain/artist.js';
import type { ArtworkRecord, ArtworkStatus } from '../domain/artwork.js';

export interface ArtworkQuery {
  status?: ArtworkStatus;
  artist?: string;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface ArtworkPage {
  items: ArtworkRecord[];
  total: number;
}

/**
 * Persistence for artworks. Optimistic writes like ArtistStore. `list` orders featured first, then
 * newest (createdAt desc, id desc): the gallery order.
 */
export interface ArtworkStore {
  create(record: ArtworkRecord): Promise<void>;
  get(id: string): Promise<ArtworkRecord | null>;
  save(record: ArtworkRecord): Promise<ArtworkRecord>;
  list(query: ArtworkQuery): Promise<ArtworkPage>;
  countByArtist(address: string): Promise<ArtworkCounts>;
}
