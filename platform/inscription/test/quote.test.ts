import { describe, expect, it } from 'vitest';
import { buildHalfSignedReveal, estimateRevealWeight, LIMITS, quoteReveal } from '../src/index.js';
import { buildAll, COMMIT_OUTPOINT, content, NETWORK, PARENT, RECIPIENT, REVEAL_PRIV } from './helpers.js';

describe('quoteReveal', () => {
  it('integer fee rates', () => {
    expect(quoteReveal({ revealWeight: 4000, feeRate: 2, postage: 546n })).toEqual({
      revealVsize: 1000,
      revealFee: 2000n,
      commitValue: 2546n,
    });
  });

  it('vsize rounds up from weight', () => {
    expect(quoteReveal({ revealWeight: 4001, feeRate: 1, postage: 0n }).revealVsize).toBe(1001);
  });

  it('fractional fee rates are exact decimals, rounded up', () => {
    // 1000 * 1.1 in binary floats is 1100.0000000000002; must be 1100, not 1101.
    expect(quoteReveal({ revealWeight: 4000, feeRate: 1.1, postage: 546n }).revealFee).toBe(1100n);
    expect(quoteReveal({ revealWeight: 4000, feeRate: 0.1, postage: 0n }).revealFee).toBe(100n);
    expect(quoteReveal({ revealWeight: 4 * 3, feeRate: 0.1, postage: 0n }).revealFee).toBe(1n); // 0.3 -> 1
    expect(quoteReveal({ revealWeight: 4 * 333, feeRate: 1.5, postage: 0n }).revealFee).toBe(500n); // 499.5 -> 500
    expect(quoteReveal({ revealWeight: 4 * 1000, feeRate: 2.345, postage: 330n })).toEqual({
      revealVsize: 1000,
      revealFee: 2345n,
      commitValue: 2675n,
    });
    expect(quoteReveal({ revealWeight: 4 * 7, feeRate: 1e-7, postage: 0n }).revealFee).toBe(1n);
    expect(quoteReveal({ revealWeight: 4, feeRate: 0, postage: 0n }).revealFee).toBe(0n);
  });

  it('block-sized Degent at 2 sat/vB costs ~0.02 BTC (ADR-0002)', () => {
    const w = estimateRevealWeight({ content: content(3_900_000), withParent: true, recipientScript: RECIPIENT.script, parentReturnScript: PARENT.script });
    const q = quoteReveal({ revealWeight: w, feeRate: 2, postage: LIMITS.DEFAULT_POSTAGE });
    expect(q.revealFee).toBeGreaterThan(1_900_000n);
    expect(q.revealFee).toBeLessThan(2_000_000n);
  });

  it('rejects invalid inputs', () => {
    expect(() => quoteReveal({ revealWeight: 4, feeRate: -1, postage: 0n })).toThrow();
    expect(() => quoteReveal({ revealWeight: 4, feeRate: NaN, postage: 0n })).toThrow();
    expect(() => quoteReveal({ revealWeight: 4, feeRate: 1, postage: -1n })).toThrow();
    expect(() => quoteReveal({ revealWeight: 1.5, feeRate: 1, postage: 0n })).toThrow();
  });

  it('a quote funds the real reveal at exactly the quoted fee rate or better', () => {
    const c = content(20_000);
    const weight = estimateRevealWeight({ content: c, withParent: true, recipientScript: RECIPIENT.script, parentReturnScript: PARENT.script });
    const q = quoteReveal({ revealWeight: weight, feeRate: 3.7, postage: 546n });
    const { final } = buildAll(c, q.commitValue);
    expect(final.vsize).toBe(q.revealVsize);
    // fee paid = commitValue - postage
    expect(Number(q.commitValue - 546n) / final.vsize).toBeGreaterThanOrEqual(3.7);
  });

  it('buildHalfSignedReveal refuses dust postage or a commit that does not cover postage', () => {
    const base = {
      network: NETWORK,
      revealPrivkey: REVEAL_PRIV,
      content: content(10),
      commitOutpoint: COMMIT_OUTPOINT,
      commitValue: 10_000n,
      recipientAddress: RECIPIENT.address!,
      postage: 546n,
    };
    expect(() => buildHalfSignedReveal({ ...base, postage: 329n })).toThrow(/postage/);
    expect(() => buildHalfSignedReveal({ ...base, commitValue: 546n })).toThrow(/commitValue/);
    expect(() => buildHalfSignedReveal({ ...base, recipientAddress: RECIPIENT.address!.replace('bcrt', 'tb') })).toThrow();
  });
});
