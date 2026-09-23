import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@bsh/degent-mint-sdk';
import { buildStages, buildTimeline, HAPPY_PATH, isTerminal, OFF_PATH, rescueOffered, STAGES, stageOf } from './timeline';

describe('timeline', () => {
  it('covers every ADR status exactly once between happy and off path', () => {
    expect([...HAPPY_PATH, ...OFF_PATH].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('marks steps before the current one done and after it upcoming', () => {
    const steps = buildTimeline({ status: 'queued', timeline: [] });
    const states = Object.fromEntries(steps.map((s) => [s.status, s.state]));
    expect(states.paid).toBe('done');
    expect(states.queued).toBe('current');
    expect(states.revealing).toBe('upcoming');
  });

  it('delivered is fully done', () => {
    expect(buildTimeline({ status: 'delivered', timeline: [] }).every((s) => s.state === 'done')).toBe(true);
  });

  it('inserts an off-path status after the last reached happy step', () => {
    const steps = buildTimeline({
      status: 'rescue_available',
      timeline: [
        { status: 'awaiting_payment', at: '2026-09-23T00:00:00Z' },
        { status: 'paid', at: '2026-09-23T00:01:00Z', txid: 'aa'.repeat(32) },
        { status: 'queued', at: '2026-09-23T00:02:00Z' },
        { status: 'rescue_available', at: '2026-09-23T06:02:00Z' },
      ],
    });
    const i = steps.findIndex((s) => s.status === 'rescue_available');
    expect(steps[i - 1]!.status).toBe('queued');
    expect(steps[i]!.state).toBe('problem');
    expect(steps.find((s) => s.status === 'paid')!.event?.txid).toBe('aa'.repeat(32));
  });

  it('member review sits between the confirmed commit and the lane', () => {
    expect(HAPPY_PATH.slice(4, 8)).toEqual(['paid', 'confirming', 'member_review', 'queued']);
    const steps = buildTimeline({ status: 'member_review', timeline: [] });
    const states = Object.fromEntries(steps.map((s) => [s.status, s.state]));
    expect(states.confirming).toBe('done');
    expect(states.member_review).toBe('current');
    expect(states.queued).toBe('upcoming');
    const declined = buildTimeline({ status: 'declined', timeline: [{ status: 'member_review', at: '2026-09-23T00:00:00Z' }, { status: 'declined', at: '2026-09-24T00:00:00Z' }] });
    const i = declined.findIndex((s) => s.status === 'declined');
    expect(declined[i - 1]!.status).toBe('member_review');
    expect(declined[i]!.state).toBe('problem');
    expect(rescueOffered('declined')).toBe(true);
    expect(rescueOffered('rescue_available')).toBe(true);
    expect(rescueOffered('member_review')).toBe(false);
  });

  it('maps every status onto the four stages Design -> Mint -> Confirm -> Approve', () => {
    expect(STAGES).toEqual(['design', 'mint', 'confirm', 'approve']);
    for (const s of ORDER_STATUSES) expect(STAGES).toContain(stageOf(s));
    expect(stageOf('reviewing')).toBe('design');
    expect(stageOf('awaiting_payment')).toBe('mint');
    expect(stageOf('confirming')).toBe('confirm');
    expect(stageOf('member_review')).toBe('approve');
    expect(stageOf('delivered')).toBe('approve');
    expect(buildStages({ status: 'confirming' }).map((s) => s.state)).toEqual(['done', 'done', 'current', 'upcoming']);
    expect(buildStages({ status: 'delivered' }).map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(buildStages({ status: 'declined' }).map((s) => s.state)).toEqual(['done', 'done', 'done', 'problem']);
    expect(buildStages({ status: 'rejected' }).map((s) => s.state)).toEqual(['problem', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('knows which states are terminal', () => {
    expect(isTerminal('delivered')).toBe(true);
    expect(isTerminal('rescue_available')).toBe(false);
    expect(isTerminal('rejected')).toBe(true);
  });
});
