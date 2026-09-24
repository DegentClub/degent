import { describe, expect, it } from 'vitest';
import {
  LISTING_STATUSES,
  LISTING_TRANSITIONS,
  SETTLEMENT_LAYOUT,
  assertRoyaltyBps,
  buyerCost,
  canTransition,
  dustFor,
  estimateVsize,
  feeForVsize,
  presetsFromMempool,
  priceInWindow,
  royaltyFor,
  satsToBtc,
} from '../src/index.js';

/** Deterministic PRNG (mulberry32) so the property tests are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('royaltyFor', () => {
  it('floors (legacy vectors)', () => {
    expect(royaltyFor(100_000, 250)).toBe(2_500n);
    expect(royaltyFor(99_999, 1)).toBe(9n);
    expect(royaltyFor(100_000, 0)).toBe(0n);
    expect(royaltyFor(250_000, 250)).toBe(6_250n);
  });

  it('property: 0 <= royalty <= price*bps/10000 < royalty+1, monotone in price and rate', () => {
    const r = rng(42);
    for (let i = 0; i < 5_000; i++) {
      const price = BigInt(Math.floor(r() * 10_000_000_000)) + 1_000n; // 1 000 sats .. 100 BTC
      const bps = Math.floor(r() * 5001);
      const royalty = royaltyFor(price, bps);
      const exact = price * BigInt(bps); // royalty*10000 <= exact < (royalty+1)*10000
      expect(royalty >= 0n).toBe(true);
      expect(royalty * 10_000n <= exact).toBe(true);
      expect(exact < (royalty + 1n) * 10_000n).toBe(true);
      expect(royalty <= price / 2n).toBe(true); // capped at 50 %
      expect(royaltyFor(price + 1n, bps) >= royalty).toBe(true);
      if (bps < 5000) expect(royaltyFor(price, bps + 1) >= royalty).toBe(true);
      // the seller always gets the full price; the buyer total adds exactly the royalty
      expect(buyerCost(price, royalty, 0) - price).toBe(royalty);
    }
  });

  it('rejects out-of-range rates and non-integer prices', () => {
    expect(() => royaltyFor(1000, -1)).toThrow(RangeError);
    expect(() => royaltyFor(1000, 5001)).toThrow(RangeError);
    expect(() => royaltyFor(1000, 1.5)).toThrow(RangeError);
    expect(() => royaltyFor(1000.5, 100)).toThrow(RangeError);
    expect(assertRoyaltyBps(5000)).toBe(5000);
  });
});

describe('fees', () => {
  it('estimates a taproot 4-in/5-out tx at roughly 450 vB (legacy vector)', () => {
    const v = estimateVsize(['tr', 'tr', 'tr', 'tr'], ['tr', 'tr', 'tr', 'tr', 'tr']);
    expect(v).toBeGreaterThan(430);
    expect(v).toBeLessThan(470);
    expect(v).toBe(Math.ceil(10.5 + 4 * 57.75 + 5 * 43));
  });

  it('feeForVsize is exact decimal and rounds up', () => {
    expect(feeForVsize(1000, 1.1)).toBe(1100n);
    expect(feeForVsize(447, 20)).toBe(8940n);
    expect(feeForVsize(3, 0.5)).toBe(2n);
    expect(feeForVsize(0, 5)).toBe(0n);
    expect(() => feeForVsize(10, 0)).toThrow(RangeError);
    expect(() => feeForVsize(1.5, 1)).toThrow(RangeError);
  });

  it('property: fee / vsize >= rate and fee - vsize*rate < 1 sat', () => {
    const r = rng(7);
    for (let i = 0; i < 2_000; i++) {
      const vsize = Math.floor(r() * 5_000) + 1;
      const rate = Math.round((r() * 200 + 0.001) * 1000) / 1000;
      const fee = feeForVsize(vsize, rate);
      const exactMilli = BigInt(vsize) * BigInt(Math.round(rate * 1000));
      expect(fee * 1000n >= exactMilli).toBe(true);
      expect(fee * 1000n - exactMilli < 1000n).toBe(true);
    }
  });

  it('maps mempool presets, never below the minimum or 1 sat/vB', () => {
    expect(presetsFromMempool({ fastestFee: 20, halfHourFee: 10, hourFee: 6, economyFee: 3, minimumFee: 1 })).toEqual({ economy: 3, normal: 10, fast: 20, minimum: 1 });
    expect(presetsFromMempool({ economyFee: 1, minimumFee: 4 })).toEqual({ economy: 4, normal: 5, fast: 10, minimum: 4 });
    expect(presetsFromMempool(null)).toEqual({ economy: 2, normal: 5, fast: 10, minimum: 1 });
    expect(presetsFromMempool({ fastestFee: 'x', minimumFee: -3 })).toEqual({ economy: 2, normal: 5, fast: 10, minimum: 1 });
  });

  it('dust thresholds per script type', () => {
    expect(dustFor('tr')).toBe(330n);
    expect(dustFor('wpkh')).toBe(294n);
    expect(dustFor('pkh')).toBe(546n);
  });
});

describe('formatting, windows, layout, statuses', () => {
  it('satsToBtc is exact', () => {
    expect(satsToBtc(50_000)).toBe('0.00050000');
    expect(satsToBtc(10_000_000_000n)).toBe('100.00000000');
    expect(satsToBtc(1)).toBe('0.00000001');
  });

  it('price window [1 000 sats, 100 BTC], integers only', () => {
    const w = { priceMinSats: 1000, priceMaxSats: 100 * 1e8 };
    expect(priceInWindow(1000, w)).toBe(true);
    expect(priceInWindow(999, w)).toBe(false);
    expect(priceInWindow(100 * 1e8 + 1, w)).toBe(false);
    expect(priceInWindow(1000.5, w)).toBe(false);
  });

  it('publishes the padding layout: inscription at input 2, price at output 2, inscription to output 1', () => {
    expect(SETTLEMENT_LAYOUT).toEqual({ dummyCount: 2, inscriptionInput: 2, priceOutput: 2, inscriptionOutput: 1, sellerSighash: 0x83, minDummyValue: 600 });
  });

  it('terminal statuses have no exits; open ones reach every terminal', () => {
    for (const s of ['sold', 'invalid', 'expired', 'cancelled'] as const) expect(LISTING_TRANSITIONS[s]).toEqual([]);
    expect(Object.keys(LISTING_TRANSITIONS)).toEqual([...LISTING_STATUSES]);
    expect(canTransition('active', 'pending')).toBe(true);
    expect(canTransition('pending', 'active')).toBe(true);
    expect(canTransition('sold', 'active')).toBe(false);
    expect(canTransition('pending', 'expired')).toBe(false);
  });
});
