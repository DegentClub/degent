/**
 * In-memory sliding-window rate limiter.
 *
 * Scope: a single Node.js process. Every replica keeps its own counters, so
 * with N instances the effective limit is N times the configured one. Deploy
 * behind a single instance, or swap the store for Redis (see docs/SECURITY.md)
 * before scaling horizontally.
 */

export interface RateLimitOptions {
  /** Maximum number of hits allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the oldest hit in the window expires (0 when allowed). */
  retryAfterMs: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(opts: RateLimitOptions) {
    if (opts.limit < 1) throw new Error('limit must be >= 1');
    if (opts.windowMs < 1) throw new Error('windowMs must be >= 1');
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.lastSweep = this.now();
  }

  /** Record a hit for `key` and report whether it is within the limit. */
  hit(key: string): RateLimitResult {
    const now = this.now();
    this.maybeSweep(now);

    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterMs: recent[0] + this.windowMs - now };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, remaining: this.limit - recent.length, retryAfterMs: 0 };
  }

  /** Check without recording a hit. */
  peek(key: string): RateLimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: recent[0] + this.windowMs - now };
    }
    return { allowed: true, remaining: this.limit - recent.length, retryAfterMs: 0 };
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  /** Drop stale keys occasionally so the map cannot grow without bound. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, times] of Array.from(this.hits.entries())) {
      const recent = times.filter((t: number) => t > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

const ONE_MINUTE = 60_000;

/** Per-client-IP budget for the create-commit proxy. */
export const ipLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: ONE_MINUTE });
/** Per-recipient-address budget: stops one wallet from being spammed with quotes. */
export const recipientLimiter = new SlidingWindowLimiter({ limit: 5, windowMs: ONE_MINUTE });

/**
 * Best-effort client IP extraction. Only trust x-forwarded-for when the app is
 * actually behind a proxy that sets it (the docker-compose nginx setup does).
 */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
