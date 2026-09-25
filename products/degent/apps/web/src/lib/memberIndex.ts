/**
 * The certified membership, walked lazily through block.space's keyset pages and cached.
 *
 * The contract pages by an opaque cursor (stable across refreshes), so a random-access pager
 * ("page 57 of 206", "last") is built on top: batches of up to 500 are fetched in order, only as far
 * as the requested range needs, and never twice. Positions are 0-based here; `DEGENT #N` is position+1
 * (the attestation's order: inscription number, then id).
 */
import { CERTIFY_MAX_LIMIT, type CertifiedItem, type CertifyApi } from '../services/certifyApi';

export interface MemberIndex {
  /** Members fetched so far (in order). */
  loadedCount(): number;
  /** True once the last page has been fetched. */
  complete(): boolean;
  /** The cached slice [start, end), or null while any of it is not fetched yet. */
  peek(start: number, end: number): CertifiedItem[] | null;
  /** Fetch as far as `end` (or the end of the collection) and return the slice [start, end). */
  load(start: number, end: number): Promise<CertifiedItem[]>;
}

export function createMemberIndex(certify: CertifyApi, slug: string, opts: { batch?: number } = {}): MemberIndex {
  const batch = Math.max(1, Math.min(CERTIFY_MAX_LIMIT, opts.batch ?? CERTIFY_MAX_LIMIT));
  const items: CertifiedItem[] = [];
  let cursor: string | null = null;
  let done = false;
  let chain: Promise<void> = Promise.resolve();

  const fetchUntil = (end: number): Promise<void> => {
    // Serialise: concurrent requests extend one walk instead of racing the same cursor.
    chain = chain.then(async () => {
      while (!done && items.length < end) {
        const page = await certify.listItems(slug, { cursor, limit: batch });
        items.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor || page.items.length === 0) done = true;
      }
    });
    const current = chain;
    // A failed walk must not poison later calls.
    chain = chain.catch(() => undefined);
    return current;
  };

  return {
    loadedCount: () => items.length,
    complete: () => done,
    peek(start, end) {
      const s = Math.max(0, start);
      if (end <= items.length || (done && s <= items.length)) return items.slice(s, end);
      return null;
    },
    async load(start, end) {
      await fetchUntil(end);
      return items.slice(Math.max(0, start), end);
    },
  };
}
