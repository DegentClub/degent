import { describe, expect, it } from 'vitest';
import {
  BLOCK_LANE_WEIGHT_BUDGET,
  blockSlotOf,
  DEFAULT_CONFIG,
  estimateTotal,
  fitsInFlight,
  laneForWeight,
  packBlockSlots,
  STANDARD_LANE_MAX_WEIGHT,
  etaMinutesForPosition,
  formatBtc,
  formatSats,
  isSha256Hex,
  sha256Hex,
  tierForSize,
  validateContentMeta,
} from '../src/index.js';

describe('DEFAULT_CONFIG', () => {
  it('encodes the ADR-0005 tiers (content bytes) and limits', () => {
    expect(DEFAULT_CONFIG.tiers).toEqual([
      expect.objectContaining({ tier: 'standard', minBytes: 200_000, maxBytes: 400_000, lane: 'standard', sharesBlock: true, label: 'Standard Degent' }),
      expect.objectContaining({ tier: 'large', minBytes: 400_001, maxBytes: 3_499_999, lane: 'block', sharesBlock: true, label: 'Large Degent' }),
      expect.objectContaining({ tier: 'fullblock', minBytes: 3_500_000, maxBytes: 3_900_000, lane: 'block', sharesBlock: false, label: 'Full Block Degent' }),
    ]);
    expect(DEFAULT_CONFIG.serviceFeeSats).toEqual({ standard: 0, large: 0, fullblock: 0 });
    expect(DEFAULT_CONFIG.allowedContentTypes).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif']);
    expect(DEFAULT_CONFIG.minDimensionPx).toBe(256);
    expect(DEFAULT_CONFIG.maxDimensionPx).toBe(4096);
    expect(DEFAULT_CONFIG.postageSats).toBe(546);
    expect(DEFAULT_CONFIG.minFeeRate).toBe(1);
    expect(DEFAULT_CONFIG.quoteTtlSeconds).toBe(900);
    expect(DEFAULT_CONFIG.rescueAfterSeconds).toBe(21_600);
  });
});

describe('tierForSize', () => {
  it.each([
    [0, null],
    [199_999, null],
    [200_000, 'standard'],
    [397_000, 'standard'],
    [400_000, 'standard'],
    [400_001, 'large'],
    [1_200_000, 'large'],
    [3_499_999, 'large'],
    [3_500_000, 'fullblock'],
    [3_900_000, 'fullblock'],
    [3_900_001, null],
    [-1, null],
    [1.5, null],
  ])('%d bytes -> %s', (bytes, tier) => {
    expect(tierForSize(bytes)?.tier ?? null).toBe(tier);
  });

  it('tiers are contiguous and non-overlapping', () => {
    const t = DEFAULT_CONFIG.tiers;
    for (let i = 1; i < t.length; i++) expect(t[i]!.minBytes).toBe(t[i - 1]!.maxBytes + 1);
  });
});

describe('lanes are decided by weight, not by tier', () => {
  it.each([
    [1, 'standard'],
    [400_000, 'standard'],
    [400_001, 'block'],
    [3_990_000, 'block'],
    [3_990_001, null],
    [0, null],
  ])('%d WU -> %s', (w, lane) => {
    expect(laneForWeight(w)).toBe(lane);
  });
  it('the thresholds are the consensus/policy numbers', () => {
    expect(STANDARD_LANE_MAX_WEIGHT).toBe(400_000);
    expect(BLOCK_LANE_WEIGHT_BUDGET).toBe(3_990_000);
  });
  it('a Standard Degent whose reveal weighs more than 400,000 WU is still a Standard Degent (tier) on the block lane', () => {
    // 398,000 content bytes weigh ~401,300 WU with the envelope (see @bsh/inscription README table).
    expect(tierForSize(398_000)?.tier).toBe('standard');
    expect(laneForWeight(401_300)).toBe('block');
  });
});

describe('block-lane packing (ADR-0005 §4)', () => {
  const large = (id: string, weight = 1_200_000) => ({ id, weight, sharesBlock: true });
  const full = (id: string) => ({ id, weight: 3_923_476, sharesBlock: false });

  it('three Large Degents of ~1.2M WU share one block slot; a fourth opens the next', () => {
    const slots = packBlockSlots([large('a'), large('b'), large('c'), large('d')]);
    expect(slots.map((s) => s.items.map((x) => x.id))).toEqual([['a', 'b', 'c'], ['d']]);
    expect(slots[0]!.weight).toBe(3_600_000);
    expect(blockSlotOf(slots, 'c')).toBe(1);
    expect(blockSlotOf(slots, 'd')).toBe(2);
    expect(blockSlotOf(slots, 'zzz')).toBeNull();
  });

  it('a Full Block Degent never shares, before or after', () => {
    const slots = packBlockSlots([large('a'), full('F'), large('b'), large('c')]);
    expect(slots.map((s) => s.items.map((x) => x.id))).toEqual([['a'], ['F'], ['b', 'c']]);
  });

  it('never exceeds the budget and never reorders', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, weight: 500_000 + ((i * 7919) % 3_400_000), sharesBlock: i % 9 !== 0 }));
    const slots = packBlockSlots(items);
    for (const s of slots) {
      expect(s.weight).toBeLessThanOrEqual(BLOCK_LANE_WEIGHT_BUDGET);
      expect(s.weight).toBe(s.items.reduce((a, x) => a + x.weight, 0));
      if (s.items.some((x) => !x.sharesBlock)) expect(s.items).toHaveLength(1);
    }
    expect(slots.flatMap((s) => s.items.map((x) => x.id))).toEqual(items.map((x) => x.id));
    expect(slots.map((s) => s.index)).toEqual(slots.map((_, i) => i + 1));
  });

  it('in-flight reveals form slot 1 and waiting orders that fit join it', () => {
    const slots = packBlockSlots([large('w1'), large('w2', 2_000_000)], { inFlight: [large('f')] });
    expect(slots.map((s) => s.items.map((x) => x.id))).toEqual([['f', 'w1'], ['w2']]);
    expect(fitsInFlight([large('f')], large('w1'))).toBe(true);
    expect(fitsInFlight([large('f')], large('w2', 2_800_000))).toBe(false);
    expect(fitsInFlight([large('f')], full('F'))).toBe(false);
    expect(fitsInFlight([full('F')], large('w1'))).toBe(false);
    expect(fitsInFlight([], full('F'))).toBe(true);
    expect(fitsInFlight([], { id: 'x', weight: 3_990_001, sharesBlock: true })).toBe(false);
  });
});

describe('validateContentMeta', () => {
  it('passes a valid standard item and reports every check', () => {
    const r = validateContentMeta({ contentType: 'image/webp', contentLength: 250_000, width: 1024, height: 1024, tier: 'standard' });
    expect(r.ok).toBe(true);
    expect(r.tier?.tier).toBe('standard');
    expect(r.checks.map((c) => c.id)).toEqual(['content_type', 'size', 'tier', 'width', 'height']);
    expect(r.reasons).toEqual([]);
  });

  it('rejects disallowed types, out-of-range size, tier mismatch and dimensions', () => {
    const r = validateContentMeta({ contentType: 'image/svg+xml', contentLength: 100, width: 100, height: 5000, tier: 'large' });
    expect(r.ok).toBe(false);
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed).toEqual(['content_type', 'size', 'tier', 'width', 'height']);
    expect(r.reasons).toHaveLength(5);
  });

  it('detects a declared tier that does not match the size', () => {
    const r = validateContentMeta({ contentType: 'image/png', contentLength: 500_000, tier: 'standard' });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'tier')?.passed).toBe(false);
  });

  it('skips dimension checks when not provided', () => {
    const r = validateContentMeta({ contentType: 'image/gif', contentLength: 1_000_000 });
    expect(r.ok).toBe(true);
    expect(r.tier?.tier).toBe('large');
    expect(validateContentMeta({ contentType: 'image/gif', contentLength: 3_600_000, tier: 'fullblock' }).ok).toBe(true);
    expect(r.checks.some((c) => c.id === 'width')).toBe(false);
  });

  it('dimension bounds are inclusive', () => {
    expect(validateContentMeta({ contentType: 'image/png', contentLength: 200_000, width: 256, height: 4096 }).ok).toBe(true);
    expect(validateContentMeta({ contentType: 'image/png', contentLength: 200_000, width: 255, height: 4096 }).ok).toBe(false);
    expect(validateContentMeta({ contentType: 'image/png', contentLength: 200_000, width: 256, height: 4097 }).ok).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('isSha256Hex accepts only lowercase 64-hex', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex(42)).toBe(false);
  });
});

describe('formatting', () => {
  it('formatSats groups thousands', () => {
    expect(formatSats(0)).toBe('0 sats');
    expect(formatSats(1)).toBe('1 sat');
    expect(formatSats(1_234_567)).toBe('1,234,567 sats');
    expect(formatSats(-2000n)).toBe('-2,000 sats');
  });
  it('formatBtc is exact to 8 decimals', () => {
    expect(formatBtc(2_000_546)).toBe('0.02000546 BTC');
    expect(formatBtc(100_000_000n)).toBe('1.00000000 BTC');
    expect(formatBtc(2_100_000_000_000_000n)).toBe('21000000.00000000 BTC');
    expect(formatBtc(-1)).toBe('-0.00000001 BTC');
  });
  it('rejects non-integer amounts', () => {
    expect(() => formatSats(1.5)).toThrow(RangeError);
  });
});

describe('estimateTotal', () => {
  const quote = { revealFeeSats: 2_000_000, postageSats: 546, commitValueSats: 2_000_546, serviceFeeSats: 10_000 };
  it('sums commit value and service fee', () => {
    expect(estimateTotal(quote).totalSats).toBe(2_010_546);
  });
  it('adds an optional funding fee estimate (rounded up)', () => {
    const t = estimateTotal(quote, { vsize: 153, feeRate: 2.5 });
    expect(t.fundingFeeSats).toBe(383);
    expect(t.totalSats).toBe(2_010_929);
  });
  it('property: total == commit + service + funding for many inputs', () => {
    for (let i = 0; i < 200; i++) {
      const reveal = (i * 7919) % 5_000_000;
      const q = { revealFeeSats: reveal, postageSats: 546, commitValueSats: reveal + 546, serviceFeeSats: i * 13 };
      const t = estimateTotal(q, { vsize: 100 + i, feeRate: 1 + (i % 7) / 3 });
      expect(t.totalSats).toBe(q.commitValueSats + q.serviceFeeSats + t.fundingFeeSats);
      expect(t.fundingFeeSats).toBeGreaterThanOrEqual((100 + i) * (1 + (i % 7) / 3));
    }
  });
  it('eta is position x 10 minutes', () => {
    expect(etaMinutesForPosition(3)).toBe(30);
    expect(etaMinutesForPosition(null)).toBeNull();
  });
});
