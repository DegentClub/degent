import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from '@bsh/degent-mint-sdk';
import { IllegalTransitionError, PRE_PAID, TERMINAL, TRANSITIONS, canTransition, transition } from '../src/domain/state-machine.js';

const ALLOWED: Array<[OrderStatus, OrderStatus]> = [
  ['awaiting_content', 'reviewing'],
  ['awaiting_content', 'expired'],
  ['reviewing', 'approved'],
  ['reviewing', 'rejected'],
  ['reviewing', 'expired'],
  ['approved', 'awaiting_payment'],
  ['approved', 'expired'],
  ['awaiting_payment', 'paid'],
  ['awaiting_payment', 'expired'],
  ['awaiting_payment', 'failed'],
  ['paid', 'queued'],
  ['paid', 'rescue_available'],
  ['queued', 'revealing'],
  ['queued', 'rescue_available'],
  ['revealing', 'revealed'],
  ['revealing', 'queued'],
  ['revealing', 'rescue_available'],
  ['revealed', 'confirmed'],
  ['confirmed', 'verified'],
  ['confirmed', 'failed'],
  ['verified', 'delivered'],
  ['expired', 'paid'],
  ['rescue_available', 'revealed'],
];

describe('order state machine', () => {
  it('covers every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it.each(ALLOWED)('%s -> %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(from, to)).toBe(to);
  });

  it('every other pair throws IllegalTransitionError (exhaustive)', () => {
    const allowed = new Set(ALLOWED.map(([a, b]) => `${a}>${b}`));
    let illegal = 0;
    for (const from of ORDER_STATUSES)
      for (const to of ORDER_STATUSES) {
        if (allowed.has(`${from}>${to}`)) continue;
        illegal++;
        expect(canTransition(from, to)).toBe(false);
        expect(() => transition(from, to)).toThrow(IllegalTransitionError);
      }
    expect(illegal).toBe(15 * 15 - ALLOWED.length);
  });

  it('pre-paid states can all expire; paid states can all reach rescue', () => {
    for (const s of PRE_PAID) expect(canTransition(s, 'expired')).toBe(true);
    for (const s of ['paid', 'queued', 'revealing'] as const) expect(canTransition(s, 'rescue_available')).toBe(true);
  });

  it('terminal states are rejected, delivered and failed only', () => {
    expect([...TERMINAL].sort()).toEqual(['delivered', 'failed', 'rejected']);
  });

  it('no self-loops, and nothing goes back to awaiting_content', () => {
    for (const s of ORDER_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
      expect(canTransition(s, 'awaiting_content')).toBe(false);
    }
  });

  it('the error names both states', () => {
    try {
      transition('delivered', 'paid');
    } catch (e) {
      expect(e).toMatchObject({ from: 'delivered', to: 'paid', message: 'illegal order transition delivered -> paid' });
    }
  });
});
