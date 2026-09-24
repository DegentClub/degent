import { describe, expect, it } from 'vitest';
import { inscriptionDestination, LAYOUT, legacyLayoutValues, simulateOrdinalTransfer } from '../src/index.js';

describe('simulateOrdinalTransfer (ordinal FIFO)', () => {
  it('assigns input sats to outputs in order and the tail to the fee', () => {
    const r = simulateOrdinalTransfer(
      [{ value: 1000, inscriptionOffset: 0 }, { value: 500, inscriptionOffset: 499 }, { value: 300, inscriptionOffset: 250 }],
      [{ value: 600 }, { value: 1000 }],
      200,
    );
    expect(r.placements).toEqual([
      { inputIndex: 0, destination: { kind: 'output', index: 0, offset: 0n } },
      { inputIndex: 1, destination: { kind: 'output', index: 1, offset: 899n } }, // 1000+499 = 1499 -> output 1 starts at 600
      { inputIndex: 2, destination: { kind: 'fee', offset: 150n } }, // 1000+500+250 = 1750 -> beyond 1600 of outputs
    ]);
    expect(r.fee).toBe(200n);
  });

  it('refuses a fee that contradicts the values and offsets outside the input', () => {
    expect(() => simulateOrdinalTransfer([{ value: 10 }], [{ value: 5 }], 4)).toThrow(/fee/);
    expect(() => simulateOrdinalTransfer([{ value: 10, inscriptionOffset: 10 }], [{ value: 5 }], 5)).toThrow(/offset/);
    expect(() => inscriptionDestination([{ value: 10 }], [{ value: 5 }], 5)).toThrow(/exactly one/);
  });
});

const prices = [1_000n, 50_000n, 1_000_000n];
const postages = [330n, 546n, 10_000n];
const paddings: Array<[bigint, bigint]> = [
  [600n, 600n],
  [1_000n, 1_000n],
  [5_000n, 5_000n],
  [600n, 5_000n],
  [330n, 331n],
];
const fees = [200n, 1_500n, 40_000n];
const offsets = [0, 1, 100];

describe('the padding layout delivers the inscription to the buyer (ADR-0005 marketplace fix)', () => {
  const matrix: Array<[bigint, bigint, bigint, bigint, bigint, number]> = [];
  for (const price of prices) for (const postage of postages) for (const [a, b] of paddings) for (const fee of fees) for (const off of offsets) matrix.push([price, postage, a, b, fee, off]);

  it.each(matrix)(
    'price %d, postage %d, padding %d + %d, fee %d, inscription offset %d -> buyer output 1',
    (price, postage, a, b, fee, off) => {
      if (BigInt(off) >= postage) return; // offset must be inside the UTXO
      const payment = price + fee + 7_777n; // any payment coin large enough; 7,777 is the change
      const inputs = [
        { value: a }, // buyer padding A
        { value: b }, // buyer padding B
        { value: postage, inscriptionOffset: off }, // seller inscription
        { value: payment }, // buyer payment
      ];
      const outputs = [
        { value: a + b }, // padding merge (buyer)
        { value: postage }, // buyer receives the inscription
        { value: price }, // seller payment
        { value: 7_777n }, // buyer change
      ];
      const dest = inscriptionDestination(inputs, outputs, fee);
      expect(dest).toEqual({ kind: 'output', index: LAYOUT.buyerReceiveOutputIndex, offset: BigInt(off) });
    },
  );

  it('the padding merge must consume EXACTLY the padding sats: one sat too many drags the inscription into output 0', () => {
    const inputs = [{ value: 600n }, { value: 600n }, { value: 546n, inscriptionOffset: 0 }, { value: 20_000n }];
    const bad = [{ value: 1_201n }, { value: 546n }, { value: 10_000n }, { value: 8_000n }]; // sums to 19,747 -> fee 1,999
    expect(inscriptionDestination(inputs, bad, 1_999n)).toEqual({ kind: 'output', index: 0, offset: 1_200n });
    const good = [{ value: 1_200n }, { value: 546n }, { value: 10_000n }, { value: 8_001n }];
    expect(inscriptionDestination(inputs, good, 1_999n)).toEqual({ kind: 'output', index: 1, offset: 0n });
  });

  it('the fee never eats the inscribed sat: it comes off the tail (the buyer payment coin)', () => {
    const r = simulateOrdinalTransfer(
      [{ value: 600n }, { value: 600n }, { value: 546n, inscriptionOffset: 0 }, { value: 30_000n }],
      [{ value: 1_200n }, { value: 546n }, { value: 25_000n }],
      5_000n,
    );
    expect(r.placements[0]!.destination).toEqual({ kind: 'output', index: 1, offset: 0n });
  });
});

describe('the audited legacy layout (inscription input first) gives the inscription to the SELLER', () => {
  it.each(prices.flatMap((price) => postages.flatMap((postage) => fees.map((fee) => [price, postage, fee] as const))))(
    'price %d, postage %d, fee %d -> seller payment output 0',
    (price, postage, fee) => {
      const { inputs, outputs, fee: f } = legacyLayoutValues({ inscriptionValue: postage, price, payment: price + fee + 5_000n, fee });
      const dest = inscriptionDestination(inputs, outputs, f);
      // Output 0 is the seller's payment: they are paid AND keep the inscription. This is the bug.
      expect(dest).toEqual({ kind: 'output', index: 0, offset: 0n });
      expect(dest).not.toEqual({ kind: 'output', index: 1, offset: 0n });
    },
  );
});
