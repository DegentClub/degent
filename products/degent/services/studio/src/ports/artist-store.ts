import type { ArtistRecord } from '../domain/artist.js';

/**
 * Persistence for artists, keyed by address. Writes are optimistic: `save` checks the stored version
 * equals `record.version`, persists `version + 1` and returns the saved record; a mismatch throws
 * StaleWriteError.
 */
export interface ArtistStore {
  create(record: ArtistRecord): Promise<void>;
  get(address: string): Promise<ArtistRecord | null>;
  save(record: ArtistRecord): Promise<ArtistRecord>;
}
