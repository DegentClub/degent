/** The review queue and the only path to X (ported from Degent-X-Bot test/post-content.test.js). */
import { describe, expect, it } from 'vitest';
import { makePublisher } from './helpers.js';

describe('Publisher.submit — generated content', () => {
  it('auto tier + REVIEW_QUEUE_ENABLED=true -> queued pending, not posted', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: true });
    const r = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gm, gentlemen. the market awaits.' });
    expect(r.draft).toMatchObject({ tier: 'auto', status: 'pending' });
    expect(r.posted).toBe(false);
    expect(x.posts).toEqual([]);
  });

  it('auto tier + REVIEW_QUEUE_ENABLED=false -> approved and posted', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false });
    const r = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gm, gentlemen. the market awaits.' });
    expect(r.posted).toBe(true);
    expect(r.draft).toMatchObject({ status: 'posted', postedId: x.posts[0]!.id });
    expect(x.posts.map((p) => p.text)).toEqual(['gm, gentlemen. the market awaits.']);
  });

  it('auto tier + queue off but POSTING_ENABLED=false -> approved, not posted', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false, postingEnabled: false });
    const r = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gm.' });
    expect(r.draft.status).toBe('approved');
    expect(x.posts).toEqual([]);
  });

  it('review tier -> pending even with the queue off, NFA appended', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false });
    const r = await publisher.submit({ kind: 'milestone', dedupeKey: 'k', text: '4,113 of 10,000 minted. 1.5 GB of blockspace and counting.' });
    expect(r.draft).toMatchObject({ tier: 'review', status: 'pending' });
    expect(r.draft.text).toMatch(/NFA\.$/);
    expect(x.posts).toEqual([]);
  });

  it('manual tier (floor projection) -> pending, never posted, no NFA', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false });
    const r = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: '~$12.8M floor at completion. the math does the talking.' });
    expect(r.draft).toMatchObject({ tier: 'manual', status: 'pending' });
    expect(r.draft.text).not.toMatch(/NFA/);
    expect(x.posts).toEqual([]);
  });

  it('safety failure (wallet address) -> pending, never posted, and cannot be approved', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false });
    const r = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'tip jar: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' });
    expect(r.draft).toMatchObject({ status: 'pending', safetyFailures: ['noWalletAddresses'] });
    await expect(publisher.approve(r.draft.id, 'admin')).rejects.toThrow(/safety/);
    expect(x.posts).toEqual([]);
  });

  it('is idempotent per dedupeKey: a redelivered fact adds no second draft and posts nothing twice', async () => {
    const { publisher, x, store } = makePublisher({ reviewQueueEnabled: false });
    await publisher.submit({ kind: 'manual', dedupeKey: 'same', text: 'gm.' });
    const again = await publisher.submit({ kind: 'manual', dedupeKey: 'same', text: 'gm.' });
    expect(again).toMatchObject({ created: false, posted: false });
    expect(await store.list()).toHaveLength(1);
    expect(x.posts).toHaveLength(1);
  });

  it('a failed post marks the draft failed', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false });
    x.failNext('503 Service Unavailable');
    const r = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gm.' });
    expect(r).toMatchObject({ posted: false, draft: { status: 'failed', error: '503 Service Unavailable' } });
  });
});

describe('Publisher — approved queue', () => {
  it('posts a human-approved review draft', async () => {
    const { publisher, x } = makePublisher();
    const { draft } = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gentlemen, a partnership.' });
    await publisher.approve(draft.id, 'admin');
    expect(await publisher.publishApproved()).toMatchObject({ posted: [draft.id], refused: [], failed: [] });
    expect(x.posts.map((p) => p.text)).toEqual(['gentlemen, a partnership.']);
  });

  it('posts manual-tier content once a human approved it', async () => {
    const { publisher, x } = makePublisher();
    const { draft } = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'a word on the floor, from the owner.' });
    expect(draft).toMatchObject({ tier: 'manual', status: 'pending' });
    await publisher.approve(draft.id, 'jeirmeister');
    await publisher.publishApproved();
    expect(x.posts).toHaveLength(1);
  });

  it('refuses a manual-tier draft marked approved without an approver (a hand-edited queue)', async () => {
    const { publisher, x, store } = makePublisher();
    const { draft } = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'floor will 10x' });
    await store.update(draft.id, { status: 'approved' });
    expect(await publisher.publishApproved()).toMatchObject({ posted: [], refused: [{ id: draft.id, reason: 'needs_human_approver' }] });
    expect(x.posts).toEqual([]);
  });

  it('approve needs a name and a pending draft; reject closes it', async () => {
    const { publisher } = makePublisher();
    const { draft } = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gm.' });
    await expect(publisher.approve(draft.id, ' ')).rejects.toThrow(/approvedBy/);
    await expect(publisher.approve('nope', 'admin')).rejects.toThrow(/no draft/);
    const rejected = await publisher.reject(draft.id, 'admin');
    expect(rejected.status).toBe('rejected');
    await expect(publisher.approve(draft.id, 'admin')).rejects.toThrow(/rejected/);
  });

  it('with POSTING_ENABLED=false nothing posts, approved or not', async () => {
    const { publisher, x } = makePublisher({ postingEnabled: false });
    const { draft } = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gentlemen, a partnership.' });
    await publisher.approve(draft.id, 'admin');
    expect(await publisher.publishApproved()).toEqual({ posted: [], refused: [], failed: [] });
    expect(x.posts).toEqual([]);
  });

  it('a failed post of an approved draft is reported and marked failed', async () => {
    const { publisher, x, store } = makePublisher();
    const { draft } = await publisher.submit({ kind: 'manual', dedupeKey: 'k', text: 'gentlemen, a partnership.' });
    await publisher.approve(draft.id, 'admin');
    x.failNext('boom');
    expect(await publisher.publishApproved()).toMatchObject({ failed: [draft.id] });
    expect((await store.get(draft.id))?.status).toBe('failed');
  });
});
