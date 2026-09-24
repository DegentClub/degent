/**
 * Artist notifications (ADR-0012, contracts/openapi/degent-studio.yaml `ArtistNotification`): what the studio
 * tells an artist, as data plus one human sentence. Pure; delivery is the `ArtistNotifier` port's job.
 */
import type { ArtworkRecord } from './artwork.js';
import type { RoyaltyRecord } from './royalty.js';

export const NOTIFICATION_KINDS = ['artwork.approved', 'artwork.rejected', 'artwork.needs_human', 'royalty.recorded'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface ArtistNotification {
  kind: NotificationKind;
  /** The artist's address (the recipient). */
  artist: string;
  artworkId: string;
  title: string;
  /** One human sentence (the Telegram text; also in the webhook payload). */
  message: string;
  at: string;
  reasons?: string[];
  orderId?: string;
  edition?: number;
  royaltySats?: number;
  fundingTxid?: string;
  vout?: number;
}

/** The notification for an artwork transition, or null when the artist is not told about it. */
export function artworkNotification(r: ArtworkRecord): ArtistNotification | null {
  const last = r.timeline[r.timeline.length - 1];
  if (!last) return null;
  const base = { artist: r.artist, artworkId: r.id, title: r.title, at: last.at };
  if (last.status === 'approved') return { ...base, kind: 'artwork.approved', message: `Your Degent '${r.title}' was approved and hangs in the gallery.` };
  if (last.status === 'rejected') {
    // The latest verdict wins: a house rejection (takedown, denied appeal) over the automated one.
    const house = r.review?.house;
    const reasons = house?.decision === 'reject' ? house.reasons : (r.review?.automated?.reasons ?? []);
    return { ...base, kind: 'artwork.rejected', reasons: [...reasons], message: `Your Degent '${r.title}' was rejected${reasons.length ? `: ${reasons.join('; ')}` : ''}.` };
  }
  if (last.status === 'reviewing' && r.needsHuman) {
    const message = last.detail === 'appeal' ? `Your appeal for your Degent '${r.title}' is waiting for a house reviewer.` : `Your Degent '${r.title}' is waiting for a house reviewer.`;
    return { ...base, kind: 'artwork.needs_human', message };
  }
  return null;
}

/** "Your Degent '<title>' was minted, edition #n, <sats> sats paid in <txid>:<vout>" (edition only when known). */
export function royaltyNotification(rec: RoyaltyRecord, title: string): ArtistNotification {
  const edition = rec.edition !== undefined ? `edition #${rec.edition}, ` : '';
  return {
    kind: 'royalty.recorded',
    artist: rec.artist,
    artworkId: rec.artworkId,
    title,
    message: `Your Degent '${title}' was minted, ${edition}${rec.royaltySats} sats paid in ${rec.fundingTxid}:${rec.vout}`,
    at: rec.recordedAt,
    orderId: rec.orderId,
    ...(rec.edition !== undefined ? { edition: rec.edition } : {}),
    royaltySats: rec.royaltySats,
    fundingTxid: rec.fundingTxid,
    vout: rec.vout,
  };
}
