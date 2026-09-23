import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { RawTx, Transaction } from '@scure/btc-signer';
import { estimateRevealWeight, laneFor, LIMITS, vsizeFromWeight } from '../src/index.js';
import { buildAll, content, PARENT, RECIPIENT } from './helpers.js';

/** Weight from raw bytes, independent of both src and btc-signer's weight getter. */
function weightOfHex(txHex: string): number {
  const raw = hex.decode(txHex);
  const tx = RawTx.decode(raw);
  const stripped = RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined }).length;
  return stripped * 3 + raw.length;
}

const SIZES = [1, 100, 520, 521, 10_000, 200_000, 390_000, 400_000, 1_000_000, 3_900_000];

describe('estimateRevealWeight is EXACT against real signed transactions', () => {
  for (const size of SIZES) {
    it(`body ${size} bytes: parent layout and rescue layout`, () => {
      const c = content(size);
      const { final, rescue } = buildAll(c);
      const withParent = estimateRevealWeight({
        content: c,
        withParent: true,
        recipientScript: RECIPIENT.script,
        parentReturnScript: PARENT.script,
        parentInputScript: PARENT.script,
      });
      const withoutParent = estimateRevealWeight({ content: c, withParent: false, recipientScript: RECIPIENT.script });

      expect(final.weight).toBe(withParent);
      expect(weightOfHex(final.hex)).toBe(withParent);
      expect(Transaction.fromRaw(hex.decode(final.hex), { allowUnknownInputs: true }).weight).toBe(withParent);
      expect(final.vsize).toBe(vsizeFromWeight(withParent));

      expect(rescue.weight).toBe(withoutParent);
      expect(weightOfHex(rescue.hex)).toBe(withoutParent);
      expect(rescue.vsize).toBe(vsizeFromWeight(withoutParent));

      // Parent adds exactly one 41-byte input, one 43-byte P2TR output and a 66-byte witness.
      expect(withParent - withoutParent).toBe(4 * (41 + 43) + 66);
    });
  }

  it('omitting parentReturnScript assumes a P2TR (34-byte) return', () => {
    const c = content(1000);
    expect(estimateRevealWeight({ content: c, withParent: true, recipientScript: RECIPIENT.script })).toBe(
      estimateRevealWeight({ content: c, withParent: true, recipientScript: RECIPIENT.script, parentReturnScript: PARENT.script }),
    );
  });

  it('accounts for recipient script length (P2WPKH 22 bytes vs P2TR 34 bytes)', () => {
    const c = content(1000);
    const p2wpkh = hex.decode('0014' + '11'.repeat(20));
    expect(
      estimateRevealWeight({ content: c, withParent: false, recipientScript: RECIPIENT.script }) -
        estimateRevealWeight({ content: c, withParent: false, recipientScript: p2wpkh }),
    ).toBe(12 * 4);
  });

  it('rejects a non-P2TR parent input (key-path spend assumed)', () => {
    expect(() =>
      estimateRevealWeight({
        content: content(1),
        withParent: true,
        recipientScript: RECIPIENT.script,
        parentInputScript: hex.decode('0014' + '11'.repeat(20)),
      }),
    ).toThrow();
  });
});

describe('lanes', () => {
  const w = (size: number) =>
    estimateRevealWeight({ content: content(size), withParent: true, recipientScript: RECIPIENT.script, parentReturnScript: PARENT.script });

  it('390,000-byte body with parent is standard; 400,000 is block', () => {
    expect(laneFor(w(390_000))).toBe('standard');
    expect(w(390_000)).toBeLessThanOrEqual(LIMITS.MAX_STANDARD_TX_WEIGHT);
    expect(laneFor(w(400_000))).toBe('block');
  });

  it('~3.9 MB is block; 3.99 MB-plus is null', () => {
    expect(laneFor(w(3_900_000))).toBe('block');
    expect(laneFor(w(3_990_000))).toBeNull();
  });

  it('boundaries', () => {
    expect(laneFor(0)).toBe('standard');
    expect(laneFor(400_000)).toBe('standard');
    expect(laneFor(400_001)).toBe('block');
    expect(laneFor(3_990_000)).toBe('block');
    expect(laneFor(3_990_001)).toBeNull();
    expect(laneFor(4_000_000)).toBeNull();
  });

  it('vsizeFromWeight rounds up', () => {
    expect(vsizeFromWeight(0)).toBe(0);
    expect(vsizeFromWeight(1)).toBe(1);
    expect(vsizeFromWeight(4)).toBe(1);
    expect(vsizeFromWeight(5)).toBe(2);
  });
});
