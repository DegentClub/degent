/** The approval-tier rules for the posting queue (ported from post-content "approved queue" tests), table-driven. */
import { describe, expect, it } from 'vitest';
import { postable, selectPostable, type QueueItem } from '../src/content/approval.js';

const item = (o: Partial<QueueItem>): QueueItem => ({ id: 'q', tier: 'auto', status: 'approved', approvedBy: null, text: 'gm.', ...o });

describe('postable', () => {
  it.each([
    [{ tier: 'auto', approvedBy: null }, { ok: true }],
    [{ tier: 'auto', approvedBy: 'admin' }, { ok: true }],
    [{ tier: 'review', approvedBy: 'admin', text: 'gentlemen, a partnership.' }, { ok: true }],
    [{ tier: 'manual', approvedBy: 'jeirmeister', text: 'a word on fees.' }, { ok: true }],
    [{ tier: 'manual', approvedBy: null, text: 'floor will 10x' }, { ok: false, reason: 'needs_human_approver' }],
    [{ tier: 'manual', approvedBy: '   ' }, { ok: false, reason: 'needs_human_approver' }],
    [{ tier: 'review', approvedBy: null }, { ok: false, reason: 'needs_human_approver' }],
    [{ status: 'pending' }, { ok: false, reason: 'not_approved' }],
    [{ status: 'posted' }, { ok: false, reason: 'not_approved' }],
    [{ status: 'rejected' }, { ok: false, reason: 'not_approved' }],
    [{ tier: 'review', approvedBy: 'admin', text: 'tip jar: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }, { ok: false, reason: 'unsafe' }],
    [{ tier: 'auto', text: 'x'.repeat(300) }, { ok: false, reason: 'unsafe' }],
  ] as Array<[Partial<QueueItem>, unknown]>)('%j -> %j', (o, want) => {
    expect(postable(item(o))).toEqual(want);
  });
});

describe('selectPostable', () => {
  it('posts human-approved and auto-approved items, refuses manual without an approver, ignores pending', () => {
    const r = selectPostable([
      item({ id: 'q1', tier: 'review', approvedBy: 'admin' }),
      item({ id: 'q2', tier: 'manual', approvedBy: null, text: 'floor will 10x' }),
      item({ id: 'q3', tier: 'auto' }),
      item({ id: 'q4', status: 'pending' }),
    ]);
    expect(r.eligible.map((i) => i.id)).toEqual(['q1', 'q3']);
    expect(r.refused).toEqual([{ id: 'q2', reason: 'needs_human_approver' }]);
  });
});
