import type { Snapshot } from '../domain/model.js';
import type { SnapshotStore } from '../ports/store.js';

/** Process-local store. Snapshots are lost on restart; re-run refresh (see RUNBOOK.md). */
export class MemorySnapshotStore implements SnapshotStore {
  private readonly bySlug = new Map<string, Snapshot>();
  async put(slug: string, snapshot: Snapshot): Promise<void> {
    this.bySlug.set(slug, structuredClone(snapshot));
  }
  async latest(slug: string): Promise<Snapshot | null> {
    const s = this.bySlug.get(slug);
    return s ? structuredClone(s) : null;
  }
}
