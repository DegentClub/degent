import type { Context, MiddlewareHandler } from 'hono';
import { errorResponse, setResponseHeader } from './context.js';
import { defaultRemoteAddress, getClientIp, type RemoteAddressFn } from './client-ip.js';

export interface BucketRule {
  /** Bucket size (burst). */
  capacity: number;
  /** Tokens added per millisecond. */
  refillPerMs: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** When not allowed: ms until `cost` tokens are available. */
  retryAfterMs: number;
  /** ms until the bucket is full again. */
  resetMs: number;
}

/**
 * Token-bucket store port. `take` must be atomic per key. A Redis adapter implements it as one Lua
 * script over a hash {tokens, ts} with PEXPIRE = time-to-full (see README).
 */
export interface RateLimitStore {
  take(key: string, cost: number, rule: BucketRule, now: number): Promise<TakeResult>;
}

interface Bucket {
  tokens: number;
  ts: number;
}

/** Single-process token buckets with lazy refill and bounded memory. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;
  constructor(opts: { maxKeys?: number } = {}) {
    this.maxKeys = opts.maxKeys ?? 100_000;
  }

  get size(): number {
    return this.buckets.size;
  }

  async take(key: string, cost: number, rule: BucketRule, now: number): Promise<TakeResult> {
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(rule.capacity, b.tokens + Math.max(0, now - b.ts) * rule.refillPerMs);
      b.ts = now;
      this.buckets.delete(key); // re-insert: Map order doubles as LRU order
    } else {
      if (this.buckets.size >= this.maxKeys) this.evict(now, rule);
      b = { tokens: rule.capacity, ts: now };
    }
    this.buckets.set(key, b);
    let allowed = false;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      allowed = true;
    }
    const deficit = allowed ? 0 : cost - b.tokens;
    return {
      allowed,
      remaining: Math.floor(b.tokens),
      retryAfterMs: allowed ? 0 : Math.ceil(deficit / rule.refillPerMs),
      resetMs: Math.ceil((rule.capacity - b.tokens) / rule.refillPerMs),
    };
  }

  private evict(now: number, rule: BucketRule): void {
    // Drop buckets that have refilled completely (equivalent to absent), then the least recently used.
    for (const [k, b] of this.buckets) {
      if (b.tokens + (now - b.ts) * rule.refillPerMs >= rule.capacity) this.buckets.delete(k);
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

export type RateLimitKey = 'ip' | 'apiKey' | ((c: Context) => string | undefined | Promise<string | undefined>);

export interface RateLimitOptions {
  /** Time for an empty bucket to refill completely. */
  windowMs: number;
  /** Requests allowed per window (also the burst size). */
  max: number;
  /** 'ip' (default), 'apiKey' (falls back to ip for anonymous callers), or a custom key function. */
  key?: RateLimitKey;
  store?: RateLimitStore;
  /** Namespace so several limiters can share one store. */
  prefix?: string;
  cost?: number | ((c: Context) => number);
  /** Emit RateLimit-* headers (draft-ietf-httpapi-ratelimit-headers). Default true. */
  headers?: boolean;
  getRemoteAddress?: RemoteAddressFn;
  now?: () => number;
}

/** Token-bucket rate limiting. 429 responses carry Retry-After and the uniform JSON error body. */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) throw new Error('rateLimit: windowMs must be > 0');
  if (!Number.isInteger(opts.max) || opts.max < 1) throw new Error('rateLimit: max must be a positive integer');
  const store = opts.store ?? new InMemoryRateLimitStore();
  const rule: BucketRule = { capacity: opts.max, refillPerMs: opts.max / opts.windowMs };
  const prefix = opts.prefix ?? 'rl';
  const remote = opts.getRemoteAddress ?? defaultRemoteAddress;
  const now = opts.now ?? Date.now;
  const keyOpt = opts.key ?? 'ip';
  const policy = `${opts.max};w=${Math.ceil(opts.windowMs / 1000)}`;

  const resolveKey = async (c: Context): Promise<string> => {
    if (keyOpt === 'ip') return `ip:${getClientIp(c, remote)}`;
    if (keyOpt === 'apiKey') {
      const k = c.get('apiKey');
      return k ? `key:${k.id}` : `ip:${getClientIp(c, remote)}`;
    }
    const custom = await keyOpt(c);
    return custom ? `custom:${custom}` : `ip:${getClientIp(c, remote)}`;
  };

  return async (c, next) => {
    const key = `${prefix}:${await resolveKey(c)}`;
    const cost = typeof opts.cost === 'function' ? opts.cost(c) : (opts.cost ?? 1);
    const r = await store.take(key, cost, rule, now());
    const hdrs: Record<string, string> =
      opts.headers === false
        ? {}
        : {
            'RateLimit-Policy': policy,
            'RateLimit-Limit': String(opts.max),
            'RateLimit-Remaining': String(Math.max(0, r.remaining)),
            'RateLimit-Reset': String(Math.ceil(r.resetMs / 1000)),
          };
    if (!r.allowed) {
      return errorResponse(c, 429, 'rate_limited', 'Too many requests', {
        ...hdrs,
        'Retry-After': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))),
      });
    }
    await next();
    for (const [k, v] of Object.entries(hdrs)) setResponseHeader(c, k, v);
  };
}
