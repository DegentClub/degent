/**
 * The JSON log lines products/degent/ops builds its dashboard and alerts on: `order transition` (every transition,
 * API and worker, with time-in-status and pay->delivered latency), `art review verdict` (hard verdict + advisory
 * rules) and `mint gauges` (member_review backlog, rescue count, parent health).
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/application/logger.js';
import { LOG_ART_REVIEW, LOG_ORDER_TRANSITION } from '../src/application/order-service.js';
import { LOG_GAUGES } from '../src/worker.js';
import { browserMintToPayment, fundToReview, makeHarness, membersApprove } from './fakes/harness.js';
import { png } from './fakes/images.js';

type Line = { level: string; msg: string } & Record<string, unknown>;
function capture(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => void lines.push({ level, msg, ...fields });
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

describe('structured logs for ops', () => {
  it('logs the art review verdict with the advisory rules, and every transition with time-in-status', async () => {
    const log = capture();
    const h = makeHarness({ log });
    const b = await browserMintToPayment(h, { bytes: png(1200, 1000, 250_000), tier: 'standard' });

    const review = log.lines.find((l) => l.msg === LOG_ART_REVIEW)!;
    expect(review).toMatchObject({
      orderId: b.orderId,
      reviewer: 'rules',
      approved: true,
      reasonCount: 0,
      square: 'fail',
      pepeInTuxWithBowtie: 'unknown',
      framedWithPlacard: 'unknown',
      placardText: null,
      advisoryFails: 1,
    });

    const transitions = log.lines.filter((l) => l.msg === LOG_ORDER_TRANSITION);
    expect(transitions.map((t) => t.to)).toEqual(['reviewing', 'approved', 'awaiting_payment']);
    for (const t of transitions) {
      expect(t).toMatchObject({ orderId: b.orderId, lane: 'standard', tier: 'standard' });
      expect(typeof t.msInPreviousStatus).toBe('number');
      expect(t.payToDeliveredMs).toBeUndefined();
    }
  });

  it('logs payToDeliveredMs on the delivered transition', async () => {
    const log = capture();
    const h = makeHarness({ log });
    const art = png(1500, 1500, 200_000);
    const b = await browserMintToPayment(h, { bytes: art, tier: 'standard' });
    await fundToReview(h, b);
    h.clock.advance(600);
    await membersApprove(h, b.orderId);
    await h.worker.tick();
    h.chain.mine();
    await h.worker.tick();
    const o = await h.orders.getOrder(b.orderId);
    h.chain.inscriptions.set(o.inscriptionId!, art);
    h.clock.advance(60);
    await h.worker.tick();
    const delivered = log.lines.find((l) => l.msg === LOG_ORDER_TRANSITION && l.to === 'delivered')!;
    expect(delivered.payToDeliveredMs).toBe(660_000);
    const queued = log.lines.find((l) => l.msg === LOG_ORDER_TRANSITION && l.to === 'queued')!;
    expect(queued).toMatchObject({ from: 'member_review', msInPreviousStatus: 600_000 });
  });

  it('gauges report the member_review backlog, its oldest age and parent health', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    await fundToReview(h, b);
    h.clock.advance(3600);
    const { counts, oldestSeconds, ...g } = await h.worker.gauges();
    expect(counts.member_review).toBe(1);
    expect(oldestSeconds.member_review).toBe(3600);
    expect(g).toEqual({
      memberReview: 1,
      memberReviewOldestAgeSeconds: 3600,
      rescueAvailable: 0,
      queued: 0,
      revealing: 0,
      awaitingConfirmation: 0,
      parentKnown: true,
      parentConfirmed: true,
      parentLeased: false,
    });
  });

  it('run() logs gauges at most once per interval', async () => {
    const log = capture();
    const h = makeHarness({ log });
    await h.ready;
    const ac = new AbortController();
    const done = h.worker.run(1, ac.signal, 60_000);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await done;
    const gauges = log.lines.filter((l) => l.msg === LOG_GAUGES);
    expect(gauges).toHaveLength(1);
    expect(gauges[0]).toMatchObject({ memberReview: 0, parentKnown: 1, parentConfirmed: 1, parentLeased: 0, counts: { queued: 0 } });
  });
});
