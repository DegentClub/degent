import type { FeeSource, SourceReading, Target } from '../types.js';
import { defaultFetch, rate, requestJson, trimSlash } from './http.js';
import { hostOf, type HttpSourceOptions } from './mempool.js';

/**
 * Esplora `GET {base}/fee-estimates` ({ "<blocks>": sat/vB, ... }, keys 1-25, 144, 504, 1008).
 * For each target the exact key is used; failing that the largest key below it (a shorter target is
 * the conservative, higher rate); failing that the smallest key above it.
 */
export function esploraSource(opts: HttpSourceOptions): FeeSource {
  const fetchFn = opts.fetch ?? defaultFetch();
  const url = `${trimSlash(opts.baseUrl)}/fee-estimates`;
  return {
    id: opts.id ?? `esplora:${hostOf(opts.baseUrl)}`,
    kind: 'esplora',
    async fetch(signal) {
      const b = await requestJson(fetchFn, url, signal);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('fee-estimates: expected an object');
      const est = new Map<number, number>();
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
        const n = Number(k);
        const r = rate(v);
        if (Number.isInteger(n) && n > 0 && r !== undefined) est.set(n, r);
      }
      if (est.size === 0) throw new Error('fee-estimates: no usable estimates');
      const keys = [...est.keys()].sort((a, c) => a - c);
      const targets: Partial<Record<Target, number>> = {};
      for (const t of [1, 3, 6, 144] as const) {
        const k = est.has(t) ? t : ([...keys].reverse().find((x) => x < t) ?? keys.find((x) => x > t))!;
        targets[t] = est.get(k)!;
      }
      return { targets } satisfies SourceReading;
    },
  };
}
