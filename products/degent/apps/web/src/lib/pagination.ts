/** Pure paging maths for the collection toolbar. Pages are 1-based. */

export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / perPage));
}

export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, Math.floor(page)), pages);
}

/** "Showing a–b of total" bounds (1-based, inclusive; 0–0 when empty). */
export function shownRange(page: number, perPage: number, total: number): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: 0 };
  const first = (page - 1) * perPage + 1;
  return { first, last: Math.min(total, page * perPage) };
}

/**
 * The numbered buttons: always the first and last page, the current page and its neighbours, and the
 * first four near the start (the live site shows "1 2 3 4 … 202"). `'gap'` marks an ellipsis.
 */
export function pageWindow(page: number, pages: number): Array<number | 'gap'> {
  const want = new Set<number>([1, pages, page - 1, page, page + 1]);
  if (page <= 3) for (let i = 1; i <= 4; i++) want.add(i);
  if (page >= pages - 2) for (let i = pages - 3; i <= pages; i++) want.add(i);
  const nums = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1]! > 1) out.push('gap');
    out.push(n);
  });
  return out;
}
