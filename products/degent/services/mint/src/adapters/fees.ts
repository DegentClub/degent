import type { FeesResponse } from '@bsh/degent-mint-sdk';
import type { FeePort } from '../ports/fees.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

type Fees = Omit<FeesResponse, 'network' | 'minFeeRate'>;

/**
 * esplora GET /fee-estimates ({ "<blocks>": sat/vB }). Cached for `ttlMs` to bound upstream load.
 * Block lane: recommended = next-block-ish rate (non-standard relays still pick by fee rate).
 */
export class EsploraFees implements FeePort {
  private readonly http: ReturnType<typeof httpClient>;
  private cache: { at: number; fees: Fees } | null = null;
  constructor(
    private readonly opts: { esploraUrl: string; minFeeRate: number; ttlMs?: number; now?: () => number } & HttpOptions,
  ) {
    this.http = httpClient(opts);
  }

  async getFees(): Promise<Fees> {
    const now = this.opts.now?.() ?? Date.now();
    if (this.cache && now - this.cache.at < (this.opts.ttlMs ?? 30_000)) return this.cache.fees;
    const res = await this.http(`${trimSlash(this.opts.esploraUrl)}/fee-estimates`);
    if (!res.ok) throw new Error(`fee-estimates: HTTP ${res.status}`);
    const est = (await res.json()) as Record<string, number>;
    const pick = (target: number) => {
      const keys = Object.keys(est).map(Number).filter((k) => k >= target).sort((a, b) => a - b);
      const v = keys.length ? est[String(keys[0])] : undefined;
      return Math.max(this.opts.minFeeRate, Math.ceil((v ?? this.opts.minFeeRate) * 10) / 10);
    };
    const fees: Fees = {
      standard: { slow: pick(144), normal: pick(6), fast: pick(1) },
      block: { min: this.opts.minFeeRate, recommended: pick(1) },
      fetchedAt: new Date(now).toISOString(),
    };
    this.cache = { at: now, fees };
    return fees;
  }
}

/** Fixed fees (dev / regtest, and a fallback when the upstream is down). */
export class StaticFees implements FeePort {
  constructor(private readonly fees: Omit<Fees, 'fetchedAt'>, private readonly now: () => Date = () => new Date()) {}
  async getFees(): Promise<Fees> {
    return { ...this.fees, fetchedAt: this.now().toISOString() };
  }
}
