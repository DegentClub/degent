/** Exponential backoff: delay(attempt) = min(maxMs, initialMs * factor^(attempt-1)), optionally jittered. */
export interface BackoffPolicy {
  initialMs: number;
  factor: number;
  maxMs: number;
  /** `full`: uniform [0, d]; `equal`: d/2 + uniform [0, d/2]; `none`: d (default; deterministic). */
  jitter?: 'none' | 'full' | 'equal';
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 1_000, factor: 2, maxMs: 60_000, jitter: 'none' };

/** Delay before retry number `attempt` (1 = delay after the first failure). */
export function backoffDelay(attempt: number, p: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const base = Math.min(p.maxMs, p.initialMs * Math.pow(p.factor, Math.max(0, attempt - 1)));
  switch (p.jitter ?? 'none') {
    case 'full':
      return Math.floor(random() * base);
    case 'equal':
      return Math.floor(base / 2 + random() * (base / 2));
    default:
      return Math.floor(base);
  }
}
