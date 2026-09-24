import { describe, expect, it } from 'vitest';
import { pageOfIndex, pageWindow, paginate, parseGoTo } from '../../src/site/lib/pagination';

describe('paginate', () => {
  it('matches the live site (4,027 at 20 per page = 202 pages)', () => {
    const p = paginate(4027, 20, 1);
    expect(p).toMatchObject({ pages: 202, page: 1, start: 0, end: 20 });
    expect(paginate(4027, 20, 202)).toMatchObject({ start: 4020, end: 4027 });
  });

  it('clamps pages and handles empty lists', () => {
    expect(paginate(45, 20, 99).page).toBe(3);
    expect(paginate(45, 20, -4).page).toBe(1);
    expect(paginate(0, 20, 3)).toMatchObject({ pages: 1, page: 1, start: 0, end: 0 });
    expect(paginate(10, 0, 1).perPage).toBe(1);
  });

  it('every item lands on exactly one page (property)', () => {
    for (const total of [1, 19, 20, 21, 4112]) {
      for (const per of [20, 40, 60, 120]) {
        const pages = paginate(total, per, 1).pages;
        let seen = 0;
        for (let p = 1; p <= pages; p++) {
          const i = paginate(total, per, p);
          seen += i.end - i.start;
          for (const idx of [i.start, i.end - 1]) expect(pageOfIndex(idx, per)).toBe(p);
        }
        expect(seen).toBe(total);
      }
    }
  });
});

describe('pageWindow', () => {
  it('first page: 1 2 3 4 … N', () => {
    expect(pageWindow(1, 202)).toEqual([1, 2, 3, 4, 'gap', 202]);
  });
  it('last page: 1 … N-3 … N', () => {
    expect(pageWindow(202, 202)).toEqual([1, 'gap', 199, 200, 201, 202]);
  });
  it('middle: 1 … p-1 p p+1 … N', () => {
    expect(pageWindow(50, 202)).toEqual([1, 'gap', 49, 50, 51, 'gap', 202]);
  });
  it('never hides a single page behind a gap', () => {
    expect(pageWindow(4, 10)).toEqual([1, 2, 3, 4, 5, 'gap', 10]);
  });
  it('small counts list every page', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 0)).toEqual([]);
  });
  it('always contains the current, first and last page, strictly increasing (property)', () => {
    for (let pages = 1; pages <= 30; pages++) {
      for (let p = 1; p <= pages; p++) {
        const w = pageWindow(p, pages);
        const nums = w.filter((x): x is number => x !== 'gap');
        expect(nums).toContain(p);
        expect(nums[0]).toBe(1);
        expect(nums.at(-1)).toBe(pages);
        for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThan(nums[i - 1]!);
      }
    }
  });
});

describe('parseGoTo', () => {
  it('parses and clamps', () => {
    expect(parseGoTo('7', 10)).toBe(7);
    expect(parseGoTo(' #99 ', 10)).toBe(10);
    expect(parseGoTo('0', 10)).toBe(1);
    expect(parseGoTo('abc', 10)).toBeNull();
    expect(parseGoTo('2.5', 10)).toBeNull();
  });
});
