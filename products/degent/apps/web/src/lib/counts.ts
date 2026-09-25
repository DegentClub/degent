/**
 * Every count on the site comes from the block.space attestation (site spec, "Known defects": the old
 * site showed 4,027 / 1,470 MB while collection.json said 4,112 and an internal analysis 4,113). This
 * module turns an attestation into the numbers the UI shows and keeps the PROJECTED target visibly
 * separate from what is CERTIFIED ("10K = 3+ GB" is a projection, not a fact).
 */
import type { Attestation } from '../services/certifyApi';
import { groupDigits } from './format';

/**
 * The collection's published target (site copy "10K = 3+ GB Blockspace"). A projection: shown only
 * with the word "projected", never as a count.
 */
export const PROJECTED_TARGET = Object.freeze({ supply: 10_000, blockspaceBytes: 3_000_000_000 });

export interface CollectionCounts {
  /** Certified members (`stats.itemCount`). */
  minted: number;
  /** Certified content bytes (`stats.totalContentBytes`, ord `content_length`). */
  bytes: number;
  excluded: number;
  asOfBlockHeight: number;
  issuedAt: string;
  method: Attestation['method'];
  slug: string;
  name: string;
  /** Share of the projected target that is certified, 0..100 (capped). */
  mintedPct: number;
  bytesPct: number;
  /** Open Studio attribution summary, when the attestation carries one. */
  studio: { mints: number; artists: number; artworks: number } | null;
  /** False when a manifest source is present but not inscribed under the parent (its items do not count). */
  manifestVerified: boolean | null;
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);

export function countsFrom(att: Attestation): CollectionCounts {
  const s = att.stats;
  const manifest = att.sources.find((x) => x.type === 'manifest');
  const attr = s.attribution;
  return {
    minted: s.itemCount,
    bytes: s.totalContentBytes,
    excluded: s.excludedCount,
    asOfBlockHeight: att.asOfBlockHeight,
    issuedAt: att.issuedAt,
    method: att.method,
    slug: att.collection.slug,
    name: att.collection.name,
    mintedPct: pctOf(s.itemCount, PROJECTED_TARGET.supply),
    bytesPct: pctOf(s.totalContentBytes, PROJECTED_TARGET.blockspaceBytes),
    studio: attr ? { mints: Object.values(attr.editions).reduce((a, b) => a + b, 0), artists: attr.artists, artworks: attr.artworks } : null,
    manifestVerified: manifest && manifest.type === 'manifest' ? manifest.verified : null,
  };
}

/** "1,508 MB" (SI, 1 MB = 1,000,000 bytes, rounded to whole MB). */
export function formatMB(bytes: number): string {
  return `${groupDigits(Math.round(bytes / 1_000_000))} MB`;
}

/** "3 GB" / "1.51 GB" (SI). */
export function formatGB(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(2)} GB`;
}

/** "41.12%" */
export function formatPct(p: number): string {
  return `${p.toFixed(2)}%`;
}
