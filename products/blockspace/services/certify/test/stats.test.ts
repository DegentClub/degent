import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/domain/canonical-json.js';
import type { Item } from '../src/domain/model.js';
import { computeStats, itemsDigest, median, sortItems } from '../src/domain/stats.js';

const id = (n: number, idx = 0) => `${n.toString(16).padStart(64, '0')}i${idx}`;
const item = (n: number, number: number, contentLength: number, idx = 0): Item => ({
  inscriptionId: id(n, idx),
  number,
  contentLength,
  contentType: 'image/webp',
  height: 800_000 + n,
  sources: ['parent-children'],
});

/** Deterministic PRNG (mulberry32) so the property tests are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('median', () => {
  it('odd, even, single, empty', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([205_000, 3_962_660])).toBe(2_083_830);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });
  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('computeStats', () => {
  const items = [item(1, 10, 300), item(2, 11, 100), item(3, 12, 200), item(4, 13, 400)];

  it('counts, totals, extremes, median and numbering', () => {
    const s = computeStats(items, 2, null);
    expect(s).toMatchObject({
      itemCount: 4,
      excludedCount: 2,
      totalContentBytes: 1000,
      minItemBytes: 100,
      maxItemBytes: 400,
      medianItemBytes: 250,
      firstInscriptionNumber: 10,
      lastInscriptionNumber: 13,
      totalRevealVbytes: null,
      revealTxCount: null,
    });
    expect(s.itemsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty collection gives nulls, not zeros or NaN', () => {
    const s = computeStats([], 0, new Map());
    expect(s).toMatchObject({ itemCount: 0, totalContentBytes: 0, minItemBytes: null, maxItemBytes: null, medianItemBytes: null, firstInscriptionNumber: null, lastInscriptionNumber: null, totalRevealVbytes: 0, revealTxCount: 0 });
  });

  it('cursed (negative) inscription numbers order correctly', () => {
    const s = computeStats([item(1, 5, 1), item(2, -3, 1), item(3, 0, 1)], 0, null);
    expect([s.firstInscriptionNumber, s.lastInscriptionNumber]).toEqual([-3, 5]);
  });

  it('reveal vbytes: one reveal per distinct txid (batch reveals counted once)', () => {
    // items 1 and 5 share reveal tx 1 (i0 and i1 of the same batch reveal)
    const batch = [...items, item(1, 14, 50, 1)];
    const v = new Map([
      [id(1).slice(0, 64), 1000],
      [id(2).slice(0, 64), 200],
      [id(3).slice(0, 64), 300],
      [id(4).slice(0, 64), 400],
    ]);
    const s = computeStats(batch, 0, v);
    expect(s.totalRevealVbytes).toBe(1900);
    expect(s.revealTxCount).toBe(4);
  });

  it('a single unknown reveal makes the total null (never a partial sum)', () => {
    const v = new Map([[id(1).slice(0, 64), 1000]]);
    expect(computeStats(items, 0, v).totalRevealVbytes).toBeNull();
  });

  it('rejects impossible sizes', () => {
    expect(() => computeStats([item(1, 1, -1)], 0, null)).toThrow(RangeError);
    expect(() => computeStats([item(1, 1, 1.5)], 0, null)).toThrow(RangeError);
  });

  it('property: stats and digest are invariant under input order (200 random permutations)', () => {
    const r = rng(42);
    const many = Array.from({ length: 257 }, (_, k) => item(k + 1, 93_832_030 + Math.floor(r() * 30_000_000), 205_000 + Math.floor(r() * 3_757_660)));
    const ref = computeStats(many, 3, null);
    const refJson = canonicalJson(ref);
    for (let t = 0; t < 200; t++) expect(canonicalJson(computeStats(shuffle(many, r), 3, null))).toBe(refJson);
    // and matches a naive recomputation
    const sizes = many.map((i) => i.contentLength).sort((a, b) => a - b);
    expect(ref.totalContentBytes).toBe(sizes.reduce((a, b) => a + b, 0));
    expect(ref.medianItemBytes).toBe(sizes[128]);
    expect(ref.minItemBytes).toBe(sizes[0]);
    expect(ref.maxItemBytes).toBe(sizes[256]);
  });

  it('itemsDigest is sha256 of canonical [[id, number, contentLength], ...] in (number, id) order', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(sortItems(items).map((i) => [i.inscriptionId, i.number, i.contentLength])))
      .digest('hex');
    expect(itemsDigest(items)).toBe(expected);
    expect(itemsDigest([...items].reverse())).toBe(expected);
    expect(itemsDigest(items.map((i, k) => (k === 0 ? { ...i, contentLength: i.contentLength + 1 } : i)))).not.toBe(expected);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: true }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}');
  });
  it('matches RFC 8785 number and string serialisation for our domain', () => {
    expect(canonicalJson([0, -0, 1e21, 2.5, 1e-7, 'é "'])).toBe('[0,0,1e+21,2.5,1e-7,"é \\""]');
  });
  it('rejects values that JSON.stringify would silently change', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson([NaN])).toThrow(/non-finite/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/non-plain/);
    expect(() => canonicalJson(1n)).toThrow(/bigint/);
  });
});
