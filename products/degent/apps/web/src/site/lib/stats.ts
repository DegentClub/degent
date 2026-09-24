/** Formatting and projection for the collection meters (pure). Numbers come from StatsService only. */
import type { CollectionStats } from '../services/types';

/** The "3 GB" goal the live site's meter measures against (a goal, not a certified fact). */
export const BLOCKSPACE_GOAL_BYTES = 3_000_000_000;

export function pct(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part)) return 0;
  return Math.max(0, (part / whole) * 100);
}

export function formatPct(p: number): string {
  return `${p.toFixed(2)}%`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Decimal megabytes, no decimals under 10 GB: "1,508 MB". */
export function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1_000_000).toLocaleString('en-US')} MB`;
}

export function formatGB(bytes: number, digits = 1): string {
  return `${(bytes / 1_000_000_000).toFixed(digits)} GB`;
}

/** Bytes projected at full supply from the certified average: bytes / minted x supply. Null without data. */
export function projectedBytes(s: Pick<CollectionStats, 'bytes' | 'minted' | 'supply'>): number | null {
  if (!(s.minted > 0) || !(s.supply > 0)) return null;
  return (s.bytes / s.minted) * s.supply;
}

export function supplyLabel(supply: number): string {
  return supply % 1000 === 0 ? `${supply / 1000}K` : formatCount(supply);
}
