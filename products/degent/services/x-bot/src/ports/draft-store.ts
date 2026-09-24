import type { Tier } from '../content/classifier.js';
import type { DraftStatus } from '../content/approval.js';
import type { SafetyChecks } from '../content/safety.js';

export type DraftKind = 'member_joined' | 'milestone' | 'weekly' | 'manual';

export interface Draft {
  id: string;
  kind: DraftKind;
  /** Idempotency: one draft per fact (e.g. `member:4113`); re-deliveries of the same event add nothing. */
  dedupeKey: string;
  text: string;
  tier: Tier;
  reasons: string[];
  safetyFailures: Array<keyof SafetyChecks>;
  status: DraftStatus;
  createdAt: string;
  approvedBy: string | null;
  decidedAt: string | null;
  postedId: string | null;
  error: string | null;
}

/** The review queue. `add` is idempotent on `dedupeKey` and returns the existing draft when there is one. */
export interface DraftStore {
  add(d: Omit<Draft, 'id'>): Promise<{ draft: Draft; created: boolean }>;
  get(id: string): Promise<Draft | null>;
  list(status?: DraftStatus): Promise<Draft[]>;
  update(id: string, patch: Partial<Omit<Draft, 'id' | 'dedupeKey'>>): Promise<Draft>;
}
