import { TARGETS, type AggregateConfig, type BlockLaneFees, type SourceReading, type StandardFees, type Target } from './types.js';

export interface LabeledReading {
  id: string;
  reading: SourceReading;
}

export interface Aggregate {
  minFeeRate: number;
  standard: StandardFees;
  block: BlockLaneFees;
  /** Source ids that contributed at least one accepted value, in input order. */
  contributors: string[];
  /** Per source id, the values rejected as outliers ("target:1", "minRelay", "block.min", "block.recommended"). */
  outliers: Record<string, string[]>;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of empty list');
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface Obs {
  id: string;
  v: number;
}

/**
 * Robust outlier rejection. With fewer than 3 observations nothing can be called an outlier (two
 * disagreeing sources are indistinguishable), so all are kept. Otherwise a value is rejected when it
 * is further from the median than max(k × 1.4826 × MAD, minRelSpread × median).
 */
export function rejectOutliers(obs: readonly Obs[], k: number, minRelSpread: number): { kept: Obs[]; rejected: Obs[] } {
  if (obs.length < 3) return { kept: [...obs], rejected: [] };
  const m = median(obs.map((o) => o.v));
  const mad = median(obs.map((o) => Math.abs(o.v - m)));
  const tol = Math.max(k * 1.4826 * mad, minRelSpread * m);
  const kept: Obs[] = [];
  const rejected: Obs[] = [];
  for (const o of obs) (Math.abs(o.v - m) <= tol ? kept : rejected).push(o);
  return { kept, rejected };
}

/** Round UP to a multiple of `step` without binary-float artefacts (1.1 stays 1.1, 1.11 -> 1.2). */
export function ceilToStep(x: number, step: number): number {
  if (!(step > 0)) return x;
  const decimals = Math.max(0, (String(step).split('.')[1] ?? '').length);
  const n = Math.ceil(Number((x / step).toFixed(9)));
  return Number((n * step).toFixed(decimals));
}

/**
 * Median of healthy sources per target (after outlier rejection), floored at the min relay rate,
 * forced monotonic (slow <= normal <= fast), and the block lane derived under `cfg.lane`.
 * Returns null when no source produced any standard-target value.
 */
export function aggregate(readings: readonly LabeledReading[], cfg: AggregateConfig): Aggregate | null {
  const outliers: Record<string, string[]> = {};
  const contributors = new Set<string>();

  const combine = (label: string, pick: (r: SourceReading) => number | undefined): number | undefined => {
    const obs: Obs[] = [];
    for (const { id, reading } of readings) {
      const v = pick(reading);
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) obs.push({ id, v });
    }
    if (obs.length === 0) return undefined;
    const { kept, rejected } = rejectOutliers(obs, cfg.outliers.madK, cfg.outliers.minRelSpread);
    for (const r of rejected) (outliers[r.id] ??= []).push(label);
    for (const o of kept) contributors.add(o.id);
    return median(kept.map((o) => o.v));
  };

  const byTarget = new Map<Target, number>();
  for (const t of TARGETS) {
    const v = combine(`target:${t}`, (r) => r.targets?.[t]);
    if (v !== undefined) byTarget.set(t, v);
  }
  const observedMinRelay = combine('minRelay', (r) => r.minRelay);
  const blockMinObserved = combine('block.min', (r) => r.block?.min);
  const blockRecObserved = combine('block.recommended', (r) => r.block?.recommended);
  if (byTarget.size === 0) return null;

  /** Missing target: nearest shorter target (higher, conservative), else nearest longer. */
  const at = (t: Target): number => {
    const direct = byTarget.get(t);
    if (direct !== undefined) return direct;
    const shorter = TARGETS.filter((x) => x < t && byTarget.has(x)).pop();
    const longer = TARGETS.find((x) => x > t && byTarget.has(x));
    return byTarget.get((shorter ?? longer)!)!;
  };

  const minFeeRate = ceilToStep(Math.max(cfg.minRelayFeeRate, observedMinRelay ?? 0), cfg.step);
  const floor = (x: number) => ceilToStep(Math.max(minFeeRate, x), cfg.step);
  const slow = floor(at(cfg.tiers.slow));
  const normal = Math.max(slow, floor(at(cfg.tiers.normal)));
  const fast = Math.max(normal, floor(at(cfg.tiers.fast)));

  const blockMin = ceilToStep(Math.max(minFeeRate, cfg.lane.minFeeRate, blockMinObserved ?? 0), cfg.step);
  const base = (blockRecObserved ?? at(cfg.lane.recommendedTarget)) * cfg.lane.premium;
  const capped = Math.min(cfg.lane.maxFeeRate, base);
  const recommended = Math.max(blockMin, ceilToStep(capped, cfg.step));

  return {
    minFeeRate,
    standard: { slow, normal, fast },
    block: { min: blockMin, recommended },
    contributors: readings.map((r) => r.id).filter((id) => contributors.has(id)),
    outliers,
  };
}
