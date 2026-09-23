import { describe, expect, it, vi } from 'vitest';
import { capScale, classifySize, fitToRange, scaleLadder } from './compression';
import { fakeEncodedSize } from '../services/fakes';

const STANDARD = { min: 200_000, max: 390_000 };
const BLOCK = { min: 390_001, max: 3_900_000 };

/** Mock canvas encoder: size grows with quality and with scale². */
function mockEncoder(fullSize: number) {
  return vi.fn(async (q: number, s: number) => ({ size: fakeEncodedSize(fullSize, q, s) }));
}

describe('classifySize', () => {
  it('is inclusive at both ends', () => {
    expect(classifySize(199_999, STANDARD)).toBe('below');
    expect(classifySize(200_000, STANDARD)).toBe('within');
    expect(classifySize(390_000, STANDARD)).toBe('within');
    expect(classifySize(390_001, STANDARD)).toBe('above');
  });
});

describe('fitToRange', () => {
  it('finds the highest quality that fits the Standard range without downscaling', async () => {
    const enc = mockEncoder(1_400_000);
    const r = await fitToRange(enc, STANDARD);
    expect(r.status).toBe('fit');
    expect(r.best.scale).toBe(1);
    expect(r.best.size).toBeGreaterThanOrEqual(STANDARD.min);
    expect(r.best.size).toBeLessThanOrEqual(STANDARD.max);
    // Highest-quality: one bisection step higher would overflow.
    const above = fakeEncodedSize(1_400_000, r.best.quality + 0.01, 1);
    expect(above).toBeGreaterThan(STANDARD.max - 20_000);
    // Every candidate was actually measured.
    expect(r.attempts.length).toBe(enc.mock.calls.length);
  });

  it('returns the top-quality encoding immediately when it already fits', async () => {
    const enc = mockEncoder(300_000);
    const r = await fitToRange(enc, STANDARD, { maxQuality: 1 });
    expect(r.status).toBe('fit');
    expect(r.best.quality).toBe(1);
    expect(enc).toHaveBeenCalledTimes(1);
  });

  it('reports too-small when even top quality is under the minimum', async () => {
    const r = await fitToRange(mockEncoder(150_000), STANDARD);
    expect(r.status).toBe('too-small');
  });

  it('downscales when minimum quality is still too large', async () => {
    // At q=0.05 full scale: 20M * 0.126 = 2.52M > 390k → must shrink.
    const r = await fitToRange(mockEncoder(20_000_000), STANDARD);
    expect(r.status).toBe('fit');
    expect(r.best.scale).toBeLessThan(1);
    expect(classifySize(r.best.size, STANDARD)).toBe('within');
  });

  it('reports too-large when the whole ladder is exhausted', async () => {
    const r = await fitToRange(mockEncoder(500_000_000), STANDARD, { scales: [1, 0.5] });
    expect(r.status).toBe('too-large');
  });

  it('targets the Block range too', async () => {
    const r = await fitToRange(mockEncoder(6_000_000), BLOCK);
    expect(r.status).toBe('fit');
    expect(r.best.size).toBeLessThanOrEqual(BLOCK.max);
    expect(r.best.size).toBeGreaterThanOrEqual(BLOCK.min);
  });

  it('propagates encoder failures', async () => {
    const enc = vi.fn(async () => {
      throw new Error('This browser cannot encode image/webp.');
    });
    await expect(fitToRange(enc, STANDARD)).rejects.toThrow(/cannot encode/);
  });
});

describe('scale helpers', () => {
  it('never drops the short edge below the minimum dimension', () => {
    expect(scaleLadder(1000, 800, 500)).toEqual([1, 0.85, 0.7]);
    expect(scaleLadder(400, 400, 500)).toEqual([1]);
  });
  it('caps to the max dimension', () => {
    expect(capScale(8192, 4096, 4096)).toBe(0.5);
    expect(capScale(1000, 1000, 4096)).toBe(1);
  });
});
