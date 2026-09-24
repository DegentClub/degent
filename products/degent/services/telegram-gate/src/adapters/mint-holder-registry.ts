/**
 * HolderRegistry over the mint service's Register: `GET /v1/register/holder/{address}` through the typed client
 * from @bsh/degent-mint-sdk (contracts/openapi/degent-mint.yaml, HolderResponse). Retries network errors, 5xx
 * and 429 with exponential backoff; caches answers for `cacheTtlMs` (default 5 min). Verification and the
 * re-check pass `fresh: true` so a sale is seen at once; the cache absorbs page reloads and bursts.
 */
import { ApiError, type MintClient } from '@bsh/degent-mint-sdk';
import type { HolderRegistry } from '../ports/holder-registry.js';

export interface MintHolderRegistryOptions {
  cacheTtlMs?: number;
  /** Attempts after the first. */
  retries?: number;
  /** Base backoff; doubles each retry. */
  backoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class MintHolderRegistry implements HolderRegistry {
  private readonly cache = new Map<string, { degents: number[]; at: number }>();
  private readonly cacheTtlMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  requests = 0;

  constructor(
    private readonly client: Pick<MintClient, 'registerHolder'>,
    o: MintHolderRegistryOptions = {},
  ) {
    this.cacheTtlMs = o.cacheTtlMs ?? 5 * 60 * 1000;
    this.retries = o.retries ?? 3;
    this.backoffMs = o.backoffMs ?? 500;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private static retryable(e: unknown): boolean {
    if (!(e instanceof ApiError)) return true;
    return e.status === 0 || e.status === 429 || e.status >= 500;
  }

  private async fetchOnce(address: string): Promise<number[]> {
    this.requests++;
    try {
      const r = await this.client.registerHolder(address);
      if (!r || !Array.isArray(r.degents)) throw new ApiError(200, 'invalid_response', 'holder response has no degents array');
      if (r.holder === false) return [];
      return r.degents.filter((n) => Number.isSafeInteger(n) && n > 0);
    } catch (e) {
      // 404 / 422: the Register does not know the address (or rejects its shape): it holds nothing.
      if (e instanceof ApiError && (e.status === 404 || e.status === 422)) return [];
      throw e;
    }
  }

  async getHoldings(address: string, opts: { fresh?: boolean } = {}): Promise<number[]> {
    const key = /^(bc1|tb1|bcrt1)/i.test(address) ? address.toLowerCase() : address;
    const hit = this.cache.get(key);
    if (!opts.fresh && hit && this.now() - hit.at < this.cacheTtlMs) return [...hit.degents];
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const degents = await this.fetchOnce(address);
        this.cache.set(key, { degents, at: this.now() });
        return [...degents];
      } catch (e) {
        last = e;
        if (!MintHolderRegistry.retryable(e) || attempt === this.retries) break;
        await this.sleep(this.backoffMs * 2 ** attempt);
      }
    }
    throw last;
  }

  invalidate(address: string): void {
    this.cache.delete(/^(bc1|tb1|bcrt1)/i.test(address) ? address.toLowerCase() : address);
  }
}
