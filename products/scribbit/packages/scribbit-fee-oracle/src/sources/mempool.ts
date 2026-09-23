import type { FeeSource, FetchLike, SourceReading, Target } from '../types.js';
import { defaultFetch, rate, requestJson, trimSlash } from './http.js';

export interface HttpSourceOptions {
  /** Base URL including any network prefix, e.g. https://mempool.space or https://mempool.space/testnet4. */
  baseUrl: string;
  id?: string;
  fetch?: FetchLike;
}

/**
 * mempool.space-compatible `GET {base}/api/v1/fees/recommended`
 * ({ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }).
 * Mapping: 1 -> fastestFee, 3 -> halfHourFee, 6 -> hourFee, 144 -> economyFee, minRelay -> minimumFee.
 */
export function mempoolRecommendedSource(opts: HttpSourceOptions): FeeSource {
  const fetchFn = opts.fetch ?? defaultFetch();
  const url = `${trimSlash(opts.baseUrl)}/api/v1/fees/recommended`;
  return {
    id: opts.id ?? `mempool:${hostOf(opts.baseUrl)}`,
    kind: 'mempool-recommended',
    async fetch(signal) {
      const b = (await requestJson(fetchFn, url, signal)) as Record<string, unknown> | null;
      if (!b || typeof b !== 'object') throw new Error('recommended: expected an object');
      const targets: Partial<Record<Target, number>> = {};
      const set = (t: Target, v: unknown) => {
        const r = rate(v);
        if (r !== undefined) targets[t] = r;
      };
      set(1, b.fastestFee);
      set(3, b.halfHourFee);
      set(6, b.hourFee);
      set(144, b.economyFee);
      if (Object.keys(targets).length === 0) throw new Error('recommended: no usable fee fields');
      const reading: SourceReading = { targets };
      const min = rate(b.minimumFee);
      if (min !== undefined) reading.minRelay = min;
      return reading;
    },
  };
}

interface ProjectedBlock {
  blockVSize: number;
  nTx?: number;
  totalFees: number;
  medianFee: number;
  feeRange?: number[];
}

/** vB of a full block (4,000,000 WU / 4). */
const FULL_BLOCK_VSIZE = 1_000_000;

/**
 * mempool.space-compatible `GET {base}/api/v1/fees/mempool-blocks` (projected next blocks).
 *
 * Targets: target N = median fee of projected block N (N capped at the last projected block, since
 * everything in the mempool fits by then); target 144 = lowest fee in the last projected block.
 *
 * Block lane: a block-sized transaction displaces (nearly) the whole next block, so a miner takes it
 * only if it pays at least what that block would have paid. `block.recommended` is therefore the
 * displacement rate `totalFees / blockVSize` of projected block 1 (only meaningful when that block is
 * full; for a part-full block the lane floor applies and the source reports no recommendation).
 */
export function mempoolBlocksSource(opts: HttpSourceOptions): FeeSource {
  const fetchFn = opts.fetch ?? defaultFetch();
  const url = `${trimSlash(opts.baseUrl)}/api/v1/fees/mempool-blocks`;
  return {
    id: opts.id ?? `mempool-blocks:${hostOf(opts.baseUrl)}`,
    kind: 'mempool-blocks',
    async fetch(signal) {
      const raw = await requestJson(fetchFn, url, signal);
      if (!Array.isArray(raw)) throw new Error('mempool-blocks: expected an array');
      const blocks = raw.filter(isProjectedBlock);
      if (blocks.length === 0) return { targets: {} } satisfies SourceReading; // empty mempool: floor applies everywhere
      const targets: Partial<Record<Target, number>> = {};
      for (const t of [1, 3, 6] as const) {
        const blk = blocks[Math.min(t, blocks.length) - 1]!;
        const r = rate(blk.medianFee);
        if (r !== undefined) targets[t] = r;
      }
      const last = blocks[blocks.length - 1]!;
      const tail = rate(last.feeRange?.[0]);
      if (blocks.length >= 144 || tail === undefined) {
        const r = rate(last.medianFee);
        if (r !== undefined) targets[144] = r;
      } else targets[144] = tail;
      const reading: SourceReading = { targets };
      const first = blocks[0]!;
      if (first.blockVSize >= FULL_BLOCK_VSIZE * 0.95) {
        const displacement = rate(first.totalFees / first.blockVSize);
        if (displacement !== undefined) reading.block = { recommended: displacement };
      }
      return reading;
    },
  };
}

function isProjectedBlock(b: unknown): b is ProjectedBlock {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return typeof o.blockVSize === 'number' && o.blockVSize > 0 && typeof o.totalFees === 'number' && typeof o.medianFee === 'number';
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}
