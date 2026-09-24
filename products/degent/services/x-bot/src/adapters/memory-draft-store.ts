/** In-memory review queue (tests, dry runs). The legacy bot's Postgres `content_queue` was not ported (README). */
import type { DraftStatus } from '../content/approval.js';
import type { Draft, DraftStore } from '../ports/draft-store.js';

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, Draft>();
  private seq = 0;

  async add(d: Omit<Draft, 'id'>): Promise<{ draft: Draft; created: boolean }> {
    for (const existing of this.drafts.values()) if (existing.dedupeKey === d.dedupeKey) return { draft: { ...existing }, created: false };
    const draft: Draft = { ...d, id: `d${++this.seq}` };
    this.drafts.set(draft.id, draft);
    return { draft: { ...draft }, created: true };
  }

  async get(id: string): Promise<Draft | null> {
    const d = this.drafts.get(id);
    return d ? { ...d } : null;
  }

  async list(status?: DraftStatus): Promise<Draft[]> {
    return [...this.drafts.values()].filter((d) => status === undefined || d.status === status).map((d) => ({ ...d }));
  }

  async update(id: string, patch: Partial<Omit<Draft, 'id' | 'dedupeKey'>>): Promise<Draft> {
    const d = this.drafts.get(id);
    if (!d) throw new Error(`no draft ${id}`);
    Object.assign(d, patch);
    return { ...d };
  }
}
