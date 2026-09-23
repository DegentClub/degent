import { describe, it, expect } from 'vitest';
import { computeOrdinalDestination } from '../src/psbt/ordinals.js';

describe('computeOrdinalDestination (FIFO)', () => {
  it('OLD LAYOUT: inscription in input 0, price in output 0 → sat goes to the SELLER', () => {
    // Exactly what legacy/psbt-unsafe.js#buildFinalPsbt produced.
    const inputs = [{ value: 10_000 }, { value: 200_000 }]; // [inscription, buyer payment]
    const outputs = [{ value: 50_000 }, { value: 10_000 }, { value: 149_745 }]; // [price→seller, postage→buyer, change→buyer]
    const dest = computeOrdinalDestination(inputs, outputs, 0, 0);
    expect(dest.outputIndex).toBe(0); // seller's payout
    expect(dest.paidAsFee).toBe(false);
  });

  it('NEW LAYOUT: two dummies then inscription; sat lands in output 1 (buyer)', () => {
    const inputs = [{ value: 600 }, { value: 600 }, { value: 10_000 }, { value: 200_000 }];
    const outputs = [{ value: 1200 }, { value: 10_000 }, { value: 50_000 }, { value: 1_000 }, { value: 100_000 }];
    const dest = computeOrdinalDestination(inputs, outputs, 2, 0);
    expect(dest.outputIndex).toBe(1);
    expect(dest.offsetInOutput).toBe(0n);
  });

  it('respects a non-zero inscription offset within the UTXO', () => {
    const inputs = [{ value: 600 }, { value: 600 }, { value: 10_000 }];
    const outputs = [{ value: 1200 }, { value: 10_000 }, { value: 5_000 }];
    expect(computeOrdinalDestination(inputs, outputs, 2, 9_999).outputIndex).toBe(1);
    expect(computeOrdinalDestination(inputs, outputs, 2, 9_999).offsetInOutput).toBe(9_999n);
  });

  it('detects when the sat would be burned as fee', () => {
    const inputs = [{ value: 600 }, { value: 600 }, { value: 10_000 }];
    const outputs = [{ value: 1200 }, { value: 5_000 }]; // postage output too small
    const dest = computeOrdinalDestination(inputs, outputs, 2, 6_000);
    expect(dest.outputIndex).toBe(-1);
    expect(dest.paidAsFee).toBe(true);
  });

  it('detects when the dummy-merge output is too large (steals the sat)', () => {
    const inputs = [{ value: 600 }, { value: 600 }, { value: 10_000 }];
    const outputs = [{ value: 1300 }, { value: 10_000 }, { value: 5_000 }];
    expect(computeOrdinalDestination(inputs, outputs, 2, 0).outputIndex).toBe(0);
  });

  it('rejects bad indexes and offsets', () => {
    expect(() => computeOrdinalDestination([{ value: 1 }], [{ value: 1 }], 1, 0)).toThrow(RangeError);
    expect(() => computeOrdinalDestination([{ value: 10 }], [{ value: 1 }], 0, 10)).toThrow(RangeError);
  });
});
