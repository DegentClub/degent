/**
 * The Register's data model (ADR-0007 §4, docs/REGISTER.md): the Gallery roster (the first 4,112
 * Degents, inscribed before the parent existed) plus the approved children delivered by the mint.
 * Pure functions over plain records; stats are computed here and tested against known numbers.
 */
import type { HistogramBucket, RegisterMember, WeekBucket } from '@bsh/degent-mint-sdk';

export interface RosterMember {
  n: number;
  inscriptionId: string;
  inscriptionNumber: number | null;
  sat: number | null;
  sizeKb: number;
  bytes: number;
  height: number | null;
  /** ISO 8601 block time when known. */
  timestamp: string | null;
}

export interface RosterFile {
  version: number;
  collection: string;
  count: number;
  members: RosterMember[];
}

const ID_RE = /^[0-9a-f]{64}i\d+$/;

/** Parse and sanity-check a roster document. Throws on gaps, duplicates or malformed ids. */
export function parseRoster(doc: unknown): RosterMember[] {
  if (typeof doc !== 'object' || doc === null) throw new Error('roster: not an object');
  const members = (doc as RosterFile).members;
  if (!Array.isArray(members) || members.length === 0) throw new Error('roster: members missing');
  const out: RosterMember[] = members.map((m, i) => {
    if (!Number.isInteger(m.n) || m.n < 1) throw new Error(`roster: bad n at index ${i}`);
    if (typeof m.inscriptionId !== 'string' || !ID_RE.test(m.inscriptionId)) throw new Error(`roster: bad inscription id for #${m.n}`);
    if (!Number.isInteger(m.bytes) || m.bytes < 0) throw new Error(`roster: bad bytes for #${m.n}`);
    return {
      n: m.n,
      inscriptionId: m.inscriptionId,
      inscriptionNumber: Number.isInteger(m.inscriptionNumber) ? m.inscriptionNumber : null,
      sat: Number.isInteger(m.sat) ? m.sat : null,
      sizeKb: typeof m.sizeKb === 'number' ? m.sizeKb : m.bytes / 1024,
      bytes: m.bytes,
      height: Number.isInteger(m.height) ? m.height : null,
      timestamp: typeof m.timestamp === 'string' ? m.timestamp : null,
    };
  });
  out.sort((a, b) => a.n - b.n);
  out.forEach((m, i) => {
    if (m.n !== i + 1) throw new Error(`roster: numbering gap at #${i + 1}`);
  });
  if (new Set(out.map((m) => m.inscriptionId)).size !== out.length) throw new Error('roster: duplicate inscription id');
  return out;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Monday (UTC) of the ISO week containing `iso`, as YYYY-MM-DD. */
export function isoWeekStart(iso: string): string {
  const d = new Date(Date.parse(iso));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export function weekBuckets(timestamps: readonly string[]): WeekBucket[] {
  const counts = new Map<string, number>();
  for (const t of timestamps) {
    const w = isoWeekStart(t);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([week, count]) => ({ week, count }));
}

/** Size histogram in KB with fixed edges matching the tiers (200-390 KB standard, then block sizes). */
export const SIZE_EDGES_KB: readonly number[] = [0, 200, 250, 300, 350, 390, 500, 1000, 2000, 3000, 4000];

export function sizeHistogram(bytesList: readonly number[], edgesKb: readonly number[] = SIZE_EDGES_KB): HistogramBucket[] {
  const buckets: HistogramBucket[] = edgesKb.map((from, i) => ({ from, to: i + 1 < edgesKb.length ? edgesKb[i + 1]! : null, count: 0 }));
  for (const b of bytesList) {
    const kb = b / 1024;
    let idx = buckets.length - 1;
    for (let i = 0; i < buckets.length; i++) {
      const to = buckets[i]!.to;
      if (to === null || kb < to) {
        idx = i;
        break;
      }
    }
    buckets[idx]!.count++;
  }
  return buckets;
}

export function topHolders(owners: ReadonlyArray<string | null>, limit = 10): Array<{ owner: string; count: number }> {
  const counts = new Map<string, number>();
  for (const o of owners) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, limit)
    .map(([owner, count]) => ({ owner, count }));
}

export type SortKey = 'n' | 'bytes' | 'height';

/** Sort members; `height` falls back to the global inscription number, then n, when heights are unknown. */
export function sortMembers(members: readonly RegisterMember[], sort: SortKey, order: 'asc' | 'desc'): RegisterMember[] {
  const key = (m: RegisterMember): number => (sort === 'bytes' ? m.bytes : sort === 'height' ? (m.height ?? m.number ?? m.n) : m.n);
  const dir = order === 'desc' ? -1 : 1;
  return [...members].sort((a, b) => dir * (key(a) - key(b)) || a.n - b.n);
}

/** Free-text filter: a Degent number, an inscription id prefix, or an owner address prefix. */
export function matchesQuery(m: RegisterMember, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if (/^#?\d+$/.test(s)) return m.n === Number(s.replace('#', ''));
  return m.id.startsWith(s) || (m.owner?.toLowerCase().startsWith(s) ?? false);
}
