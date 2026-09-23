/**
 * Official collection statistics. Pure and deterministic: the same members (in any input order) and
 * the same reveal sizes always give byte-identical stats, which is what makes an attestation
 * reproducible by a third party running their own ord.
 */
import { canonicalJson } from './canonical-json.js';
import { sha256Hex } from './hash.js';
import type { Item, Stats } from './model.js';

/** Total order used everywhere items are listed: inscription number, then id. */
export function compareItems(a: Pick<Item, 'number' | 'inscriptionId'>, b: Pick<Item, 'number' | 'inscriptionId'>): number {
  if (a.number !== b.number) return a.number - b.number;
  return a.inscriptionId < b.inscriptionId ? -1 : a.inscriptionId > b.inscriptionId ? 1 : 0;
}

export function sortItems<T extends Pick<Item, 'number' | 'inscriptionId'>>(items: readonly T[]): T[] {
  return [...items].sort(compareItems);
}

/** sha256 of canonicalJson([[id, number, contentLength], ...]) in canonical item order. */
export function itemsDigest(items: readonly Item[]): string {
  return sha256Hex(canonicalJson(sortItems(items).map((i) => [i.inscriptionId, i.number, i.contentLength])));
}

/** Median; for an even count the mean of the two middle values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Min (dir -1) or max (dir 1) without spreading into Math.min (safe for any collection size). */
function extreme(values: readonly number[], dir: 1 | -1): number | null {
  let best: number | null = null;
  for (const v of values) if (best === null || (dir === 1 ? v > best : v < best)) best = v;
  return best;
}

/** The reveal transaction of an inscription is the txid part of its id. */
export function revealTxid(inscriptionId: string): string {
  return inscriptionId.slice(0, 64);
}

/**
 * @param revealVsizes vsize per reveal txid, or null when reveal sizes are unavailable. Every
 *   member's reveal txid must be present; a missing one makes the total null (never a partial sum).
 */
export function computeStats(items: readonly Item[], excludedCount: number, revealVsizes: ReadonlyMap<string, number> | null): Stats {
  const sizes = items.map((i) => i.contentLength);
  for (const i of items)
    if (!Number.isSafeInteger(i.contentLength) || i.contentLength < 0) throw new RangeError(`bad contentLength for ${i.inscriptionId}`);
  const numbers = items.map((i) => i.number);

  let totalRevealVbytes: number | null = null;
  let revealTxCount: number | null = null;
  if (revealVsizes) {
    const txids = [...new Set(items.map((i) => revealTxid(i.inscriptionId)))];
    if (txids.every((t) => revealVsizes.has(t))) {
      totalRevealVbytes = txids.reduce((s, t) => s + revealVsizes.get(t)!, 0);
      revealTxCount = txids.length;
    }
  }

  return {
    itemCount: items.length,
    excludedCount,
    totalContentBytes: sizes.reduce((s, x) => s + x, 0),
    minItemBytes: extreme(sizes, -1),
    maxItemBytes: extreme(sizes, 1),
    medianItemBytes: median(sizes),
    firstInscriptionNumber: extreme(numbers, -1),
    lastInscriptionNumber: extreme(numbers, 1),
    totalRevealVbytes,
    revealTxCount,
    itemsDigest: itemsDigest(items),
  };
}
