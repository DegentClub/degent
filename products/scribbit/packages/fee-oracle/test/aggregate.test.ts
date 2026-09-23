import { describe, expect, it } from 'vitest';
import { aggregate, ceilToStep, median, rejectOutliers, resolveConfig, type SourceReading } from '../src/index.js';
import { flat, prng } from './helpers.js';

const cfg = resolveConfig();
const r = (id: string, reading: SourceReading) => ({ id, reading });

describe('median / ceilToStep / rejectOutliers', () => {
  it('median of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  it('rounds up to the step without float artefacts', () => {
    expect(ceilToStep(1.1, 0.1)).toBe(1.1);
    expect(ceilToStep(1.11, 0.1)).toBe(1.2);
    expect(ceilToStep(0.30000000000000004, 0.1)).toBe(0.3);
    expect(ceilToStep(2.5, 1)).toBe(3);
    expect(ceilToStep(7, 0.25)).toBe(7);
  });

  it('keeps everything with fewer than three observations', () => {
    const { kept, rejected } = rejectOutliers([{ id: 'a', v: 1 }, { id: 'b', v: 1000 }], 3, 0.25);
    expect(kept).toHaveLength(2);
    expect(rejected).toHaveLength(0);
  });

  it('rejects a far value among three or more', () => {
    const { kept, rejected } = rejectOutliers(
      [{ id: 'a', v: 10 }, { id: 'b', v: 11 }, { id: 'c', v: 10.5 }, { id: 'd', v: 90 }],
      3,
      0.25,
    );
    expect(rejected.map((o) => o.id)).toEqual(['d']);
    expect(kept.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('never rejects values within minRelSpread of the median even when MAD is 0', () => {
    const { rejected } = rejectOutliers([{ id: 'a', v: 10 }, { id: 'b', v: 10 }, { id: 'c', v: 12 }], 3, 0.25);
    expect(rejected).toHaveLength(0);
  });
});

describe('aggregate', () => {
  it('returns null without any standard target data', () => {
    expect(aggregate([], cfg)).toBeNull();
    expect(aggregate([r('lr', { block: { min: 0.1 } })], cfg)).toBeNull();
  });

  it('takes the per-target median of healthy sources and maps tiers (fast=1, normal=3, slow=144)', () => {
    const agg = aggregate(
      [
        r('a', { targets: { 1: 10, 3: 6, 6: 4, 144: 2 } }),
        r('b', { targets: { 1: 12, 3: 7, 6: 5, 144: 2.2 } }),
        r('c', { targets: { 1: 11, 3: 8, 6: 4.5, 144: 2.4 } }),
      ],
      cfg,
    )!;
    expect(agg.standard).toEqual({ slow: 2.2, normal: 7, fast: 11 });
    expect(agg.minFeeRate).toBe(1);
    expect(agg.contributors).toEqual(['a', 'b', 'c']);
    expect(agg.outliers).toEqual({});
  });

  it('rejects an outlier source per target and reports it', () => {
    const agg = aggregate([r('a', flat(5)), r('b', flat(5.2)), r('c', flat(4.9)), r('bad', { targets: { 1: 400, 3: 5, 6: 5, 144: 5 } })], cfg)!;
    expect(agg.standard.fast).toBe(5); // median(5, 5.2, 4.9) once 400 is rejected
    expect(agg.outliers).toEqual({ bad: ['target:1'] });
    expect(agg.contributors).toContain('bad'); // still contributed accepted targets
  });

  it('floors at the configured min relay and at the observed mempool floor', () => {
    const low = aggregate([r('a', { targets: { 1: 0.5, 144: 0.2 } })], cfg)!;
    expect(low.standard).toEqual({ slow: 1, normal: 1, fast: 1 });
    expect(low.minFeeRate).toBe(1);
    const pressured = aggregate([r('a', { targets: { 1: 20, 3: 10, 144: 2 }, minRelay: 3.01 })], cfg)!;
    expect(pressured.minFeeRate).toBe(3.1);
    expect(pressured.standard.slow).toBe(3.1);
    const custom = aggregate([r('a', flat(1.5))], resolveConfig({ minRelayFeeRate: 2 }))!;
    expect(custom.minFeeRate).toBe(2);
    expect(custom.standard.fast).toBe(2);
  });

  it('forces slow <= normal <= fast when sources are inverted', () => {
    const agg = aggregate([r('a', { targets: { 1: 3, 3: 5, 144: 8 } })], cfg)!;
    expect(agg.standard).toEqual({ slow: 8, normal: 8, fast: 8 });
  });

  it('fills a missing target from the nearest shorter (conservative) target', () => {
    const agg = aggregate([r('a', { targets: { 1: 9, 144: 2 } })], cfg)!;
    expect(agg.standard.normal).toBe(9); // target 3 missing -> target 1
    const onlyLong = aggregate([r('a', { targets: { 144: 2 } })], cfg)!;
    expect(onlyLong.standard).toEqual({ slow: 2, normal: 2, fast: 2 });
  });

  describe('block lane', () => {
    it('falls back to the recommended target × premium when no block-lane source reports', () => {
      const agg = aggregate([r('a', { targets: { 1: 10, 144: 2 } })], resolveConfig({ lane: { premium: 1.25 } }))!;
      expect(agg.block).toEqual({ min: 1, recommended: 12.5 });
    });

    it('uses the median block-lane recommendation and the observed relay floor, never below minFeeRate', () => {
      const agg = aggregate(
        [r('m', { targets: { 1: 10, 144: 2 } }), r('lr', { block: { min: 0.1, recommended: 4 } }), r('mb', { targets: { 1: 9 }, block: { recommended: 6 } })],
        cfg,
      )!;
      expect(agg.block.min).toBe(1); // 0.1 observed, floored at the configured min relay
      expect(agg.block.recommended).toBe(5); // median(4, 6)
      expect(agg.contributors).toEqual(['m', 'lr', 'mb']);
    });

    it('applies the lane floor and cap', () => {
      const floored = aggregate([r('a', flat(2))], resolveConfig({ lane: { minFeeRate: 3 } }))!;
      expect(floored.block).toEqual({ min: 3, recommended: 3 });
      const capped = aggregate([r('a', flat(900))], cfg)!;
      expect(capped.block.recommended).toBe(500);
      expect(capped.standard.fast).toBe(900); // the cap is a lane policy, not a standard one
      const floorAboveCap = aggregate([r('a', flat(2))], resolveConfig({ lane: { minFeeRate: 50, maxFeeRate: 10 } }))!;
      expect(floorAboveCap.block).toEqual({ min: 50, recommended: 50 });
    });
  });

  it('property: invariants hold for random source sets', () => {
    const rand = prng(42);
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(rand() * 5);
      const readings = Array.from({ length: n }, (_, j) => {
        const reading: SourceReading = { targets: {} };
        for (const t of [1, 3, 6, 144] as const) if (rand() < 0.8) reading.targets![t] = Math.round(rand() * 2000) / 10 + 0.1;
        if (Object.keys(reading.targets!).length === 0) reading.targets![6] = 1 + rand() * 50;
        if (rand() < 0.4) reading.minRelay = 0.5 + rand() * 5;
        if (rand() < 0.3) reading.block = { min: 0.1 + rand(), recommended: rand() * 800 + 0.1 };
        return r(`s${j}`, reading);
      });
      const c = resolveConfig({ minRelayFeeRate: 0.5 + rand() * 2, lane: { premium: 1 + rand(), maxFeeRate: 50 + rand() * 500 } });
      const agg = aggregate(readings, c)!;
      const { slow, normal, fast } = agg.standard;
      expect(agg.minFeeRate).toBeGreaterThanOrEqual(c.minRelayFeeRate);
      expect(slow).toBeGreaterThanOrEqual(agg.minFeeRate);
      expect(normal).toBeGreaterThanOrEqual(slow);
      expect(fast).toBeGreaterThanOrEqual(normal);
      expect(agg.block.min).toBeGreaterThanOrEqual(Math.max(agg.minFeeRate, c.lane.minFeeRate));
      expect(agg.block.recommended).toBeGreaterThanOrEqual(agg.block.min);
      expect(agg.block.recommended).toBeLessThanOrEqual(Math.max(agg.block.min, ceilToStep(c.lane.maxFeeRate, c.step)));
      // Output never exceeds the highest input (plus rounding) unless floored.
      const maxIn = Math.max(...readings.flatMap((x) => Object.values(x.reading.targets ?? {})));
      expect(fast).toBeLessThanOrEqual(Math.max(agg.minFeeRate, ceilToStep(maxIn, c.step)));
      for (const v of [slow, normal, fast, agg.block.min, agg.block.recommended, agg.minFeeRate])
        expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-9);
    }
  });
});
