/**
 * Approval-tier rules for the posting queue (ported from Degent-X-Bot's post-content job):
 *
 *   - Only `approved` drafts are eligible.
 *   - manual and review tiers need a named human approver (`approvedBy`); a row marked approved without one is
 *     refused (a stale or hand-edited queue must not become an auto-post).
 *   - auto tier may be approved by the gate itself (review queue off) and needs no approver.
 *   - The safety checks run again at posting time: an address-shaped string never posts, whoever approved it.
 */
import type { Tier } from './classifier.js';
import { checkSafety } from './safety.js';

export type DraftStatus = 'pending' | 'approved' | 'posted' | 'rejected' | 'failed';

export interface QueueItem {
  id: string;
  tier: Tier;
  status: DraftStatus;
  approvedBy: string | null;
  text: string;
}

export type PostableVerdict = { ok: true } | { ok: false; reason: 'not_approved' | 'needs_human_approver' | 'unsafe' };

export function postable(item: QueueItem): PostableVerdict {
  if (item.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (item.tier !== 'auto' && !(item.approvedBy && item.approvedBy.trim())) return { ok: false, reason: 'needs_human_approver' };
  if (!checkSafety(item.text).pass) return { ok: false, reason: 'unsafe' };
  return { ok: true };
}

/** Split a batch of queue items into what may post now and what is refused (with the reason, for the log). */
export function selectPostable<T extends QueueItem>(items: readonly T[]): { eligible: T[]; refused: Array<{ id: string; reason: string }> } {
  const eligible: T[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  for (const it of items) {
    const v = postable(it);
    if (v.ok) eligible.push(it);
    else if (v.reason !== 'not_approved') refused.push({ id: it.id, reason: v.reason });
  }
  return { eligible, refused };
}
