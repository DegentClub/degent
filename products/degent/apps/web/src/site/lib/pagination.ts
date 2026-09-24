/** Gallery pagination maths (pure). Pages are 1-based. */

export const PER_PAGE_OPTIONS = [20, 40, 60, 120] as const;

export interface PageInfo {
  total: number;
  perPage: number;
  pages: number;
  /** Clamped current page. */
  page: number;
  /** 0-based index of the first item on the page (inclusive). */
  start: number;
  /** 0-based index one past the last item on the page. */
  end: number;
}

export function paginate(total: number, perPage: number, page: number): PageInfo {
  const t = Math.max(0, Math.floor(total));
  const pp = Math.max(1, Math.floor(perPage) || 1);
  const pages = Math.max(1, Math.ceil(t / pp));
  const p = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  const start = t === 0 ? 0 : (p - 1) * pp;
  return { total: t, perPage: pp, pages, page: p, start, end: Math.min(t, start + pp) };
}

/** The page holding 0-based item `index`. */
export function pageOfIndex(index: number, perPage: number): number {
  return Math.floor(Math.max(0, index) / Math.max(1, perPage)) + 1;
}

export type PageToken = number | 'gap';

/**
 * Page buttons: always first and last, `siblings` pages either side of the current one, and a
 * 'gap' (…) where pages are skipped. A gap never hides a single page (it shows the page instead).
 * Example (page 1 of 202): 1 2 3 4 … 202, like the live site.
 */
export function pageWindow(page: number, pages: number, siblings = 1, boundary = 1): PageToken[] {
  if (pages <= 0) return [];
  const p = Math.min(pages, Math.max(1, page));
  const set = new Set<number>();
  for (let i = 1; i <= Math.min(boundary, pages); i++) set.add(i);
  for (let i = Math.max(1, pages - boundary + 1); i <= pages; i++) set.add(i);
  // keep the window width stable at the edges (1 2 3 4 … N)
  const width = siblings * 2 + 1;
  let lo = Math.max(1, p - siblings);
  let hi = Math.min(pages, p + siblings);
  if (hi - lo + 1 < width) {
    if (lo === 1) hi = Math.min(pages, lo + width);
    else if (hi === pages) lo = Math.max(1, hi - width);
  }
  for (let i = lo; i <= hi; i++) set.add(i);
  const sorted = [...set].sort((a, b) => a - b);
  const out: PageToken[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1];
    if (prev !== undefined && cur - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && cur - prev > 2) out.push('gap');
    out.push(cur);
  }
  return out;
}

/** Parse a "go to" entry: a page number, clamped; null when not a number. */
export function parseGoTo(input: string, pages: number): number | null {
  const n = Number(input.trim().replace(/^#/, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return Math.min(pages, Math.max(1, n));
}
