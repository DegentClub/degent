import type { FeeProvider } from './oracle.js';
import { defaultFetch, redact, requestJson, trimSlash } from './sources/http.js';
import { isNetwork, type FeesResponse, type FetchLike, type Network } from './types.js';

export interface FeeClientOptions {
  /** Base URL of a scribb.it fee server (the path `/v1/fees` is appended), or the full `/v1/fees` URL. */
  url: string;
  network: Network;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Client for a remote fee server (contracts/openapi/scribbit-fees.yaml). Validates the response shape
 * and accepts degent-shaped servers too (`stale` / `sources` default to false / []).
 */
export function feeClient(opts: FeeClientOptions): FeeProvider {
  const fetchFn = opts.fetch ?? defaultFetch();
  const base = trimSlash(opts.url);
  const endpoint = /\/v1\/fees$/.test(base) ? base : `${base}/v1/fees`;
  const url = `${endpoint}?network=${encodeURIComponent(opts.network)}`;
  return {
    network: opts.network,
    async getFees() {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
      try {
        return parseFeesResponse(await requestJson(fetchFn, url, ac.signal), opts.network);
      } catch (e) {
        if (ac.signal.aborted) throw new Error(`fee server ${redact(url)} timed out`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`fees response: ${name} must be a positive number`);
  return v;
};

export function parseFeesResponse(body: unknown, expectedNetwork?: Network): FeesResponse {
  if (!body || typeof body !== 'object') throw new Error('fees response: expected an object');
  const b = body as Record<string, any>;
  if (!isNetwork(b.network)) throw new Error('fees response: invalid network');
  if (expectedNetwork && b.network !== expectedNetwork)
    throw new Error(`fees response is for ${b.network}, expected ${expectedNetwork}`);
  if (!b.standard || typeof b.standard !== 'object' || !b.block || typeof b.block !== 'object')
    throw new Error('fees response: missing standard/block');
  return {
    network: b.network,
    minFeeRate: num(b.minFeeRate, 'minFeeRate'),
    standard: { slow: num(b.standard.slow, 'standard.slow'), normal: num(b.standard.normal, 'standard.normal'), fast: num(b.standard.fast, 'standard.fast') },
    block: { min: num(b.block.min, 'block.min'), recommended: num(b.block.recommended, 'block.recommended') },
    fetchedAt: typeof b.fetchedAt === 'string' ? b.fetchedAt : new Date().toISOString(),
    stale: b.stale === true,
    sources: Array.isArray(b.sources) ? b.sources.filter((s: unknown): s is string => typeof s === 'string') : [],
  };
}
