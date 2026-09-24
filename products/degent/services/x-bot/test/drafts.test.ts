/**
 * degent.mint.order.delivered events and /v1/stats -> draft posts. Every draft goes through the classifier; Register
 * facts carry numbers, so they are review tier and never post without a human, whatever REVIEW_QUEUE_ENABLED says.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryBus, degentMintOrder, platformRegistry, type MintOrderStatusChanged } from '@bsh/events';
import { DELIVERED_TOPIC, DraftPipeline } from '../src/drafts/pipeline.js';
import { formatBytes, memberJoinedText, milestoneText, weeklyText } from '../src/drafts/templates.js';
import { INSCRIPTION, NOW, fakeRegister, makePublisher, member } from './helpers.js';

const delivered = (o: Partial<MintOrderStatusChanged> = {}): MintOrderStatusChanged => ({
  type: 'degent.mint.order.delivered',
  eventId: 'ord_1:9',
  orderId: 'ord_1',
  network: 'mainnet',
  status: 'delivered',
  previousStatus: 'confirming',
  at: new Date(NOW).toISOString(),
  lane: 'standard',
  txid: 'cd'.repeat(32),
  inscriptionId: INSCRIPTION,
  ...o,
});

describe('templates', () => {
  it.each([
    [0, '0 bytes'],
    [999, '999 bytes'],
    [1000, '1 KB'],
    [372_000, '372 KB'],
    [372_499, '372 KB'],
    [3_960_000, '3.96 MB'],
    [1_000_000, '1 MB'],
    [1_512_345_678, '1.51 GB'],
    [2_000_000_000, '2 GB'],
  ])('formatBytes(%i) = %s', (b, want) => {
    expect(formatBytes(b)).toBe(want);
  });

  it('formatBytes refuses nonsense', () => {
    expect(() => formatBytes(-1)).toThrow();
    expect(() => formatBytes(Number.NaN)).toThrow();
  });

  it('member joined: number with separators, size, block', () => {
    expect(memberJoinedText({ n: 4113, bytes: 372_000, height: 912_345 })).toBe('Degent #4,113 joined the Club. 372 KB, block 912,345.');
    expect(memberJoinedText({ n: 4114, bytes: 3_960_000, height: null })).toBe('Degent #4,114 joined the Club. 3.96 MB, on chain.');
  });

  it('milestone and weekly texts', () => {
    expect(milestoneText({ milestone: 4200, charter: 10000, totalBytes: 1_512_345_678 })).toBe(
      '4,200 of 10,000 Degents. 1.51 GB written to Bitcoin, every byte verifiable with a node.',
    );
    expect(weeklyText({ count: 12, medianBytes: 372_000, minted: 4200, charter: 10000 })).toBe(
      'This week 12 Degents joined the Club. Median size 372 KB. 4,200 of 10,000 on chain.',
    );
    expect(weeklyText({ count: 1, medianBytes: 372_000, minted: 4113, charter: 10000 })).toMatch(/^This week 1 Degent joined/);
  });
});

describe('DraftPipeline.onOrderStatus', () => {
  it('a delivered child becomes a review-tier "joined the Club" draft, never auto-posted even with the queue off', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false });
    const register = fakeRegister({ [INSCRIPTION]: member(4113, 372_000, 912_345) });
    const p = new DraftPipeline({ register, publisher });
    const r = await p.onOrderStatus(delivered());
    expect(r?.draft).toMatchObject({ kind: 'member_joined', dedupeKey: 'member:4113', tier: 'review', status: 'pending', text: 'Degent #4,113 joined the Club. 372 KB, block 912,345.' });
    expect(r?.draft.reasons).toContain('blockspace_size');
    expect(x.posts).toEqual([]);
    expect(register.calls).toEqual([`verify ${INSCRIPTION}`, 'member 4113']);
  });

  it('never states the owner address even though the Register returns one', async () => {
    const { publisher } = makePublisher();
    const r = await new DraftPipeline({ register: fakeRegister({ [INSCRIPTION]: member(4113, 372_000, 912_345) }), publisher }).onOrderStatus(delivered());
    expect(r?.draft.text).not.toMatch(/bc1/);
    expect(r?.draft.safetyFailures).toEqual([]);
  });

  it.each(['queued', 'revealing', 'confirming', 'declined', 'rescue_available', 'failed'] as const)('ignores status %s', async (status) => {
    const { publisher, store } = makePublisher();
    const register = fakeRegister({ [INSCRIPTION]: member(4113, 372_000, 912_345) });
    expect(await new DraftPipeline({ register, publisher }).onOrderStatus(delivered({ status, type: `degent.mint.order.${status}` }))).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(register.calls).toEqual([]);
  });

  it('ignores a delivered event without an inscription id, and an inscription the Register does not list', async () => {
    const { publisher, store } = makePublisher();
    const p = new DraftPipeline({ register: fakeRegister(), publisher });
    const { inscriptionId: _omit, ...noId } = delivered();
    expect(await p.onOrderStatus(noId as MintOrderStatusChanged)).toBeNull();
    expect(await p.onOrderStatus(delivered())).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('a redelivered event yields one draft', async () => {
    const { publisher, store } = makePublisher();
    const p = new DraftPipeline({ register: fakeRegister({ [INSCRIPTION]: member(4113, 372_000, 912_345) }), publisher });
    await p.onOrderStatus(delivered());
    const again = await p.onOrderStatus(delivered({ eventId: 'ord_1:10' }));
    expect(again?.created).toBe(false);
    expect(await store.list()).toHaveLength(1);
  });
});

describe('DraftPipeline.attach (platform bus)', () => {
  it('consumes degent.mint.order.delivered from @bsh/events and drafts once per event', async () => {
    const bus = new InMemoryBus({ registry: platformRegistry() });
    const { publisher, store } = makePublisher();
    const register = fakeRegister({ [INSCRIPTION]: member(4113, 372_000, 912_345) });
    await new DraftPipeline({ register, publisher }).attach(bus);
    expect(DELIVERED_TOPIC).toBe('degent.mint.order.delivered');
    const event = degentMintOrder.create({ source: 'degent-mint', params: { status: 'delivered' }, data: delivered(), id: 'evt-1' });
    await bus.publish(event);
    await bus.publish(event); // at-least-once redelivery
    await bus.publish(degentMintOrder.create({ source: 'degent-mint', params: { status: 'queued' }, data: delivered({ status: 'queued', type: 'degent.mint.order.queued' }) }));
    await new Promise((r) => setTimeout(r, 10));
    const drafts = await store.list();
    expect(drafts.map((d) => d.text)).toEqual(['Degent #4,113 joined the Club. 372 KB, block 912,345.']);
    expect(register.calls.filter((c) => c.startsWith('verify'))).toHaveLength(1);
  });
});

describe('DraftPipeline.fromStats', () => {
  it('drafts the last reached milestone and the last complete week, both review tier', async () => {
    const { publisher, x } = makePublisher({ reviewQueueEnabled: false });
    const register = fakeRegister({}, {
      minted: 4213,
      mintsPerWeek: [
        { week: '2026-09-07', count: 9 },
        { week: '2026-09-14', count: 12 },
        { week: '2026-09-21', count: 3 }, // the current week (NOW is 2026-09-24): incomplete, skipped
      ],
    });
    const r = await new DraftPipeline({ register, publisher, now: () => NOW }).fromStats();
    expect(r.map((x) => [x.draft.dedupeKey, x.draft.tier, x.draft.status])).toEqual([
      ['milestone:4200', 'review', 'pending'],
      ['week:2026-09-14', 'review', 'pending'],
    ]);
    expect(r[0]!.draft.text).toBe('4,200 of 10,000 Degents. 1.51 GB written to Bitcoin, every byte verifiable with a node.');
    expect(r[1]!.draft.text).toMatch(/^This week 12 Degents joined the Club\. Median size 372 KB\. 4,213 of 10,000 on chain\./);
    expect(x.posts).toEqual([]);
  });

  it('is idempotent across runs and honours milestoneEvery', async () => {
    const { publisher, store } = makePublisher();
    const p = new DraftPipeline({ register: fakeRegister({}, { minted: 4113 }), publisher, milestoneEvery: 1000, now: () => NOW });
    await p.fromStats();
    await p.fromStats();
    expect((await store.list()).map((d) => d.dedupeKey)).toEqual(['milestone:4000']);
  });

  it('no milestone below the first step, no weekly without a complete week', async () => {
    const { publisher, store } = makePublisher();
    await new DraftPipeline({ register: fakeRegister({}, { minted: 42 }), publisher, now: () => NOW }).fromStats();
    expect(await store.list()).toEqual([]);
  });

  it('accepts a stats object instead of fetching, and rejects a bad milestoneEvery', async () => {
    const { publisher } = makePublisher();
    const register = fakeRegister();
    const stats = await register.stats();
    register.calls.length = 0;
    await new DraftPipeline({ register, publisher, now: () => NOW }).fromStats(stats);
    expect(register.calls).toEqual([]);
    expect(() => new DraftPipeline({ register, publisher, milestoneEvery: 0 })).toThrow();
  });
});
