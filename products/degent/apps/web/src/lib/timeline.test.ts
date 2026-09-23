import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@bsh/degent-mint-sdk';
import { buildTimeline, HAPPY_PATH, isTerminal, OFF_PATH } from './timeline';

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

  it('knows which states are terminal', () => {
    expect(isTerminal('delivered')).toBe(true);
    expect(isTerminal('rescue_available')).toBe(false);
    expect(isTerminal('rejected')).toBe(true);
  });
});
