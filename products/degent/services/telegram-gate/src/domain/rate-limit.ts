/** Sliding-window limiter keyed by an arbitrary id (the Telegram user id for /verify). In-process. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Records a hit and returns true when it is within the limit; a refused hit is not recorded. */
  hit(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.every((t) => t <= now - this.windowMs)) this.hits.delete(k);
    return true;
  }
}
