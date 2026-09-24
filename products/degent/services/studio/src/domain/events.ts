/** Domain event (contracts/asyncapi/degent-studio.yaml `ArtworkStatusEvent`). */
import type { Network } from '@bsh/degent-mint-sdk';
import type { ArtworkRecord, ArtworkStatus } from './artwork.js';

export interface ArtworkStatusEvent {
  type: `degent.artwork.${ArtworkStatus}`;
  /** `<artworkId>:<1-based timeline index>`. */
  eventId: string;
  artworkId: string;
  artist: string;
  network: Network;
  status: ArtworkStatus;
  previousStatus: ArtworkStatus | null;
  at: string;
  contentSha256?: string;
  detail?: string;
}

/** The event for the LAST timeline entry of `r` (call right after a persisted transition). */
export function eventFor(r: ArtworkRecord, previousStatus: ArtworkStatus | null): ArtworkStatusEvent {
  const last = r.timeline[r.timeline.length - 1]!;
  const e: ArtworkStatusEvent = {
    type: `degent.artwork.${last.status}`,
    eventId: `${r.id}:${r.timeline.length}`,
    artworkId: r.id,
    artist: r.artist,
    network: r.network,
    status: last.status,
    previousStatus,
    at: last.at,
  };
  if (r.contentSha256) e.contentSha256 = r.contentSha256;
  if (last.detail !== undefined) e.detail = last.detail;
  return e;
}
