import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  estimateTotal,
  etaMinutesForPosition,
  formatBtc,
  formatSats,
  isSha256Hex,
  sha256Hex,
  tierForSize,
  validateContentMeta,
} from '../src/index.js';

describe('DEFAULT_CONFIG', () => {
  it('encodes the ADR-0002 tiers and limits', () => {
    expect(DEFAULT_CONFIG.tiers).toEqual([
      expect.objectContaining({ tier: 'standard', minBytes: 200_000, maxBytes: 390_000, lane: 'standard' }),
      expect.objectContaining({ tier: 'block', minBytes: 390_001, maxBytes: 3_900_000, lane: 'block' }),
    ]);
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
    [390_000, 'standard'],
    [390_001, 'block'],
    [3_900_000, 'block'],
    [3_900_001, null],
    [-1, null],
    [1.5, null],
  ])('%d bytes -> %s', (bytes, tier) => {
    expect(tierForSize(bytes)?.tier ?? null).toBe(tier);
  });

  it('tiers are contiguous and non-overlapping', () => {
    const [a, b] = DEFAULT_CONFIG.tiers;
    expect(b!.minBytes).toBe(a!.maxBytes + 1);
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
    const r = validateContentMeta({ contentType: 'image/svg+xml', contentLength: 100, width: 100, height: 5000, tier: 'block' });
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

describe('advisory minting rules', () => {
  it('carries the four site rules verbatim', async () => {
    const { MINTING_RULES } = await import('../src/index.js');
    expect(MINTING_RULES.map((r) => r.title)).toEqual(['File Format & Size', 'Essential Design', 'Framing & Text', 'Quantity']);
    expect(MINTING_RULES[2]!.text).toBe('Must be framed and include a placard that says “DEGEN”, “DEGENT”, or “REGEN”.');
  });

  it('square is exact from dimensions, unknown without them', async () => {
    const { squareRuleAdvice } = await import('../src/index.js');
    expect(squareRuleAdvice(1000, 1000).square).toBe('pass');
    expect(squareRuleAdvice(1000, 999).square).toBe('fail');
    expect(squareRuleAdvice(null, 1000).square).toBe('unknown');
  });

  it('merges earliest non-unknown verdict per rule and the first placard text', async () => {
    const { mergeRuleAdvice, unknownRuleAdvice } = await import('../src/index.js');
    const rules = { ...unknownRuleAdvice('vision only'), square: 'pass' as const, notes: { ...unknownRuleAdvice('vision only').notes, square: '800x800px is square' } };
    const vision = {
      square: 'fail' as const,
      pepeInTuxWithBowtie: 'pass' as const,
      framedWithPlacard: 'fail' as const,
      placardText: 'DEGENT' as const,
      notes: { square: 'looks wide', pepeInTuxWithBowtie: 'tux and bowtie', framedWithPlacard: 'no frame' },
    };
    const m = mergeRuleAdvice(rules, vision)!;
    expect(m).toEqual({
      square: 'pass',
      pepeInTuxWithBowtie: 'pass',
      framedWithPlacard: 'fail',
      placardText: 'DEGENT',
      notes: { square: '800x800px is square', pepeInTuxWithBowtie: 'tux and bowtie', framedWithPlacard: 'no frame' },
    });
    expect(mergeRuleAdvice(undefined, undefined)).toBeUndefined();
    expect(mergeRuleAdvice(undefined, vision)).toEqual(vision);
  });
});
