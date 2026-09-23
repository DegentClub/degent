import type { Snapshot } from '../domain/model.js';

/** Latest attestation snapshot per collection. */
export interface SnapshotStore {
  put(slug: string, snapshot: Snapshot): Promise<void>;
  latest(slug: string): Promise<Snapshot | null>;
}
