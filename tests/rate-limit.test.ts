import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter, clientIpFromHeaders } from '@/lib/rate-limit';

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('SlidingWindowLimiter', () => {
  it('allows up to `limit` hits inside the window and then blocks', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 1000, now: c.now });
    expect(limiter.hit('a')).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(limiter.hit('a').remaining).toBe(1);
    expect(limiter.hit('a').remaining).toBe(0);
    const blocked = limiter.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
  });

  it('keys are independent', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now: c.now });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('slides: old hits expire individually rather than all at once', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, now: c.now });
    limiter.hit('a'); // t=0
    c.advance(600);
    limiter.hit('a'); // t=600
    c.advance(300); // t=900: both inside window
    expect(limiter.hit('a').allowed).toBe(false);
    c.advance(101); // t=1001: first hit expired
    const res = limiter.hit('a');
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(0);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('blocked hits are not counted against the window', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now: c.now });
    limiter.hit('a');
    for (let i = 0; i < 10; i++) limiter.hit('a');
    c.advance(1001);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('peek does not consume budget', () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(limiter.peek('a').allowed).toBe(true);
    expect(limiter.peek('a').remaining).toBe(1);
    limiter.hit('a');
    expect(limiter.peek('a').allowed).toBe(false);
  });

  it('reset clears one key or all keys', () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    limiter.hit('a');
    limiter.hit('b');
    limiter.reset('a');
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(false);
    limiter.reset();
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('sweeps stale keys so memory does not grow forever', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, now: c.now });
    for (let i = 0; i < 100; i++) limiter.hit(`ip-${i}`);
    expect(limiter.size).toBe(100);
    c.advance(2001);
    limiter.hit('fresh');
    expect(limiter.size).toBe(1);
  });

  it('rejects nonsensical configuration', () => {
    expect(() => new SlidingWindowLimiter({ limit: 0, windowMs: 1000 })).toThrow();
    expect(() => new SlidingWindowLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});

describe('clientIpFromHeaders', () => {
  it('prefers the first x-forwarded-for entry', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-real-ip': '10.0.0.2' });
    expect(clientIpFromHeaders(headers)).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip then "unknown"', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '10.0.0.2' }))).toBe('10.0.0.2');
    expect(clientIpFromHeaders(new Headers())).toBe('unknown');
  });
});
