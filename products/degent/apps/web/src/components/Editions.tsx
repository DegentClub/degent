/** Edition facts (ADR-0012) as the gallery, the artwork page and the studio show them. */
import { editionsOf, type StudioArtwork } from '../services/studioApi';
import { groupDigits } from '../lib/format';
import { Badge } from './ui';

export function SoldOutBadge({ artwork }: { artwork: Pick<StudioArtwork, 'mintedEditions' | 'maxEditions' | 'soldOut'> }) {
  return editionsOf(artwork).soldOut ? <Badge tone="bad">Sold out</Badge> : null;
}

/** "3 minted of 25", "Not minted yet · open edition", or null when the studio sent no edition facts. */
export function editionsText(artwork: Pick<StudioArtwork, 'mintedEditions' | 'maxEditions' | 'soldOut'>): string | null {
  const e = editionsOf(artwork);
  if (e.minted === null && e.max === null) return null;
  const minted = e.minted === null ? null : e.minted === 0 ? 'Not minted yet' : `${groupDigits(e.minted)} minted`;
  if (e.max !== null) return `${minted ?? 'Limited edition'} of ${groupDigits(e.max)}${e.soldOut ? ' · sold out' : ''}`;
  return `${minted} · open edition`;
}
