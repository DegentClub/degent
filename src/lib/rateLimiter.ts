/**
 * In-memory sliding-window rate limiter.
 *
 * Good enough for a single Node process (the default `next start`). Behind a
 * multi-instance deployment it limits per instance; put a shared limiter in
 * front or set ATELIER_API_KEY instead.
 */

export interface RateLimiterOptions {
  /** Max hits per window. */
  limit: number
  /** Window length in ms. */
  windowMs: number
  /** Clock, injectable for tests. */
  now?: () => number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  /** Epoch ms when the oldest hit in the window expires (when a slot frees up). */
  resetAt: number
  /** Seconds until a retry could succeed; 0 when allowed. */
  retryAfterSeconds: number
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private ops = 0

  constructor(opts: RateLimiterOptions) {
    if (opts.limit < 1) throw new Error('limit must be >= 1')
    if (opts.windowMs < 1) throw new Error('windowMs must be >= 1')
    this.limit = opts.limit
    this.windowMs = opts.windowMs
    this.now = opts.now ?? Date.now
  }

  /** Record a hit for `key` and report whether it is within the limit. */
  hit(key: string): RateLimitResult {
    const now = this.now()
    const cutoff = now - this.windowMs
    this.maybeSweep(cutoff)
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff)

    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      const resetAt = recent[0] + this.windowMs
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      }
    }

    recent.push(now)
    this.hits.set(key, recent)

    return {
      allowed: true,
      remaining: this.limit - recent.length,
      resetAt: recent[0] + this.windowMs,
      retryAfterSeconds: 0,
    }
  }

  /** Inspect without recording. */
  peek(key: string): number {
    const cutoff = this.now() - this.windowMs
    return (this.hits.get(key) ?? []).filter((t) => t > cutoff).length
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear()
    else this.hits.delete(key)
  }

  get size(): number {
    return this.hits.size
  }

  /** Drop idle keys every so often so the map does not grow forever. */
  private maybeSweep(cutoff: number): void {
    if (++this.ops % 500 !== 0) return
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key)
    }
  }
}

/** First hop of x-forwarded-for, else x-real-ip, else a stable fallback. */
export function clientKeyFromHeaders(headers: Headers): string {
  const xff = headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = headers.get('x-real-ip')
  if (real) return real.trim()
  return 'unknown'
}

// Module-level singleton so the window survives across requests within a
// process. Next.js reuses the module in `next start`.
const globalStore = globalThis as unknown as { __atelierRateLimiter?: SlidingWindowRateLimiter }

export const GENERATE_LIMIT = 5
export const GENERATE_WINDOW_MS = 10 * 60 * 1000

export function getGenerateRateLimiter(): SlidingWindowRateLimiter {
  if (!globalStore.__atelierRateLimiter) {
    globalStore.__atelierRateLimiter = new SlidingWindowRateLimiter({
      limit: GENERATE_LIMIT,
      windowMs: GENERATE_WINDOW_MS,
    })
  }
  return globalStore.__atelierRateLimiter
}
