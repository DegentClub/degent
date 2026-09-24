import type { ArtistNotifyRecord } from '../domain/artist.js';
import type { ArtistNotification } from '../domain/notifications.js';

export type NotifyChannel = 'webhook' | 'telegram';

/**
 * Delivers artist notifications to the targets on the artist's profile (ADR-0012). The adapter is
 * `BshArtistNotifier` over `@bsh/notify` (signed webhooks, Telegram). `notify` must not throw for delivery
 * failures (retries are the adapter's business); the service never lets a notification fail a request.
 */
export interface ArtistNotifier {
  /** Channels this deployment delivers (`webhook` always; `telegram` when a bot is configured). */
  readonly channels: readonly NotifyChannel[];
  /** Throws an Error with a user-safe message when the target is unusable. */
  validateTarget(channel: NotifyChannel, target: string): void;
  /**
   * Deliver `n` to the artist's current targets. `eventId` is stable per fact (`<artworkId>:<timeline index>`,
   * `royalty:<orderId>`), so a repeat of the same fact is de-duplicated by the delivery log.
   */
  notify(artist: { address: string; notify: ArtistNotifyRecord }, n: ArtistNotification, eventId: string): Promise<void>;
}
