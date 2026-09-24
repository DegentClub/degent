/**
 * `ArtistNotifier` over `@bsh/notify` (ADR-0012): signed webhooks always, Telegram when a bot token is
 * configured. Retries, backoff and idempotency keys are the platform Notifier's.
 *
 * Routing. The platform Notifier matches subscriptions by event TYPE, so each artist gets a private topic:
 * `degent.studio.notify.<recipient>.<kind>` where `<recipient>` = the first 32 hex characters of
 * sha256(address) (addresses are not always valid routing-key words; legacy ones have upper case). The
 * artist's subscriptions (`degent.studio.notify.<recipient>.#`) are re-synced from the artist record right
 * before each delivery: the record is the source of truth, so in-memory subscription stores are a cache that
 * survives nothing and needs nothing to survive.
 *
 * Secrets. The webhook signing secret is resolved from the artist record at send time; it is never part of a
 * subscription and never logged.
 */
import { createHash } from 'node:crypto';
import { createEvent, type Clock as EventsClock, type EventEnvelope } from '@bsh/events';
import {
  Notifier,
  TelegramChannel,
  WebhookChannel,
  validateWebhookTarget,
  type DeliveryLog,
  type DeliveryOutcome,
  type FetchLike,
  type NotificationChannel,
  type RetryPolicy,
  type SubscriptionStore,
  type TelegramClient,
} from '@bsh/notify';
import type { ArtistNotifyRecord } from '../domain/artist.js';
import type { ArtistNotification } from '../domain/notifications.js';
import type { ArtistStore } from '../ports/artist-store.js';
import type { ArtistNotifier, NotifyChannel } from '../ports/artist-notifier.js';

export const NOTIFY_SOURCE = 'urn:bsh:degent-studio';
export const NOTIFY_TOPIC_PREFIX = 'degent.studio.notify';

/** First 32 hex characters of sha256(address): the artist's routing-key word. */
export function recipientKey(address: string): string {
  return createHash('sha256').update(address, 'utf8').digest('hex').slice(0, 32);
}

export function notificationType(address: string, kind: ArtistNotification['kind']): string {
  return `${NOTIFY_TOPIC_PREFIX}.${recipientKey(address)}.${kind}`;
}

const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export interface BshArtistNotifierOptions {
  /** Where webhook secrets are read at send time. */
  artists: Pick<ArtistStore, 'get'>;
  /** HTTP for webhook deliveries (global fetch in production, a fake in tests). */
  fetch: FetchLike;
  /** Telegram Bot API client; null/absent = no Telegram channel. */
  telegram?: TelegramClient | null;
  /** Accept http:// and localhost / private literal-IP webhook targets (regtest dev only). */
  allowInsecureWebhooks?: boolean;
  /** Timer clock for retries (`@bsh/events` Clock; tests pass a ManualClock). */
  clock?: EventsClock;
  /** Unix-seconds clock for the webhook signature timestamp. */
  nowSec?: () => number;
  subscriptions?: SubscriptionStore;
  deliveryLog?: DeliveryLog;
  retry?: Partial<Record<NotifyChannel, RetryPolicy>>;
  random?: () => number;
  onOutcome?: (o: DeliveryOutcome) => void;
}

export class BshArtistNotifier implements ArtistNotifier {
  readonly channels: readonly NotifyChannel[];
  /** The platform notifier (dead letters in `notifier.failed`, `pendingRetries`, `stop()`). */
  readonly notifier: Notifier;
  private readonly insecure: boolean;

  constructor(private readonly o: BshArtistNotifierOptions) {
    this.insecure = o.allowInsecureWebhooks === true;
    const channels: NotificationChannel[] = [
      new WebhookChannel({
        fetch: o.fetch,
        secrets: async (sub) => {
          const a = await o.artists.get(sub.subscriberId);
          const secret = a?.notify?.webhookSecret;
          if (!secret || a.notify?.webhookUrl !== sub.target) throw new Error('the artist no longer has this webhook');
          return secret;
        },
        ...(o.nowSec ? { nowSec: o.nowSec } : {}),
        allowHttp: this.insecure,
        allowPrivateHosts: this.insecure,
        userAgent: 'degent-studio (bsh-notify)',
      }),
    ];
    if (o.telegram) channels.push(new TelegramChannel(o.telegram, (e: EventEnvelope) => ({ subject: 'degent.club', text: (e.data as ArtistNotification).message })));
    this.channels = channels.map((c) => c.kind as NotifyChannel);
    this.notifier = new Notifier({
      channels,
      ...(o.subscriptions ? { subscriptions: o.subscriptions } : {}),
      ...(o.deliveryLog ? { deliveryLog: o.deliveryLog } : {}),
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.retry ? { retry: o.retry } : {}),
      ...(o.random ? { random: o.random } : {}),
      ...(o.onOutcome ? { onOutcome: o.onOutcome } : {}),
    });
  }

  validateTarget(channel: NotifyChannel, target: string): void {
    if (!this.channels.includes(channel)) throw new Error(`${channel} notifications are not enabled on this studio`);
    if (channel === 'webhook') validateWebhookTarget(target, { allowHttp: this.insecure, allowPrivateHosts: this.insecure });
    else if (!TELEGRAM_CHAT.test(target)) throw new Error('telegramChatId must be a numeric chat id or an @channel name');
  }

  /** Re-sync the artist's subscriptions from the record, then deliver. Resolves after the first attempts. */
  async notify(artist: { address: string; notify: ArtistNotifyRecord }, n: ArtistNotification, eventId: string): Promise<void> {
    await this.deliver(artist, n, eventId);
  }

  /** `notify` returning the per-subscription outcomes (tests, metrics). */
  async deliver(artist: { address: string; notify: ArtistNotifyRecord }, n: ArtistNotification, eventId: string): Promise<DeliveryOutcome[]> {
    const key = recipientKey(artist.address);
    const topics = [`${NOTIFY_TOPIC_PREFIX}.${key}.#`];
    const targets: Array<[NotifyChannel, string | null]> = [
      ['webhook', artist.notify.webhookUrl && artist.notify.webhookSecret ? artist.notify.webhookUrl : null],
      ['telegram', artist.notify.telegramChatId],
    ];
    for (const [channel, target] of targets) {
      const id = `${key}:${channel}`;
      if (target && this.channels.includes(channel)) await this.notifier.subscribe({ id, subscriberId: artist.address, channel, target, topics });
      else await this.notifier.unsubscribe(id);
    }
    const event = createEvent({ source: NOTIFY_SOURCE, type: notificationType(artist.address, n.kind), subject: n.artworkId, id: eventId, time: n.at, data: n });
    return this.notifier.handle(event);
  }

  stop(): void {
    this.notifier.stop();
  }
}
