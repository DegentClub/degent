/**
 * Order notifications (POST /v1/orders/{id}/subscriptions): a minter asks to hear about ONE order by email or
 * Telegram. Delivery, retries, idempotency keys and dead letters are `@bsh/notify`; this service only owns the
 * per-order subscription records (PII, never in events or public order views), the copy, and the wiring from
 * the order-status events (`degent.mint.order.{status}`, as CloudEvents envelopes) to the Notifier.
 *
 * Only four transitions notify (NOTIFY_STATUSES): member_review, declined, rescue_available, delivered.
 *
 * The platform Notifier matches subscriptions by topic only, so a subscription for
 * `degent.mint.order.delivered` would hear every order. Each event is therefore handled by a Notifier scoped
 * to that order's subscriptions; all of them share the channels' senders and ONE DeliveryLog, so a bus
 * redelivery of the same event (same eventId) never notifies twice.
 */
import { createHash } from 'node:crypto';
import {
  EmailChannel,
  InMemoryDeliveryLog,
  Notifier,
  TelegramChannel,
  type DeliveryLog,
  type DeliveryOutcome,
  type EmailSender,
  type FailedNotification,
  type NotificationChannel,
  type RenderedMessage,
  type TelegramClient,
} from '@bsh/notify';
import type { Clock as RetryClock, EventEnvelope } from '@bsh/events';
import { NOTIFY_STATUSES, type NotifyChannel, type NotifyStatus, type Order, type OrderStatusEvent, type OrderSubscription } from '@bsh/degent-mint-sdk';
import { DomainError, conflict, invalid } from '../domain/errors.js';
import type { Clock } from '../ports/clock.js';
import type { OrderSubscriptionRecord, OrderSubscriptionStore } from '../ports/order-subscription-store.js';
import { MINT_EVENT_SOURCE, toPlatformEnvelope } from '../adapters/platform-event-bus.js';
import type { OrderService } from './order-service.js';
import { silentLogger, type Logger } from './logger.js';

export const MAX_SUBSCRIPTIONS_PER_ORDER = 3;
const CLOSED: readonly string[] = ['rejected', 'delivered', 'failed'];
const CHANNELS: readonly NotifyChannel[] = ['email', 'telegram_chat'];
/** Our API channel name -> the @bsh/notify channel kind. */
const KIND: Record<NotifyChannel, string> = { email: 'email', telegram_chat: 'telegram' };
const TOPICS = NOTIFY_STATUSES.map((s) => `degent.mint.order.${s}`);

export interface NotificationServiceDeps {
  orders: OrderService;
  subscriptions: OrderSubscriptionStore;
  /** Email provider; null/undefined disables the email channel (503 channel_unavailable). */
  email?: EmailSender | null;
  /** Telegram Bot API client; null/undefined disables the telegram_chat channel. */
  telegram?: TelegramClient | null;
  deliveryLog?: DeliveryLog;
  clock: Clock;
  /** Timer clock for @bsh/notify retries (default: the system clock). */
  retryClock?: RetryClock;
  /** Public site origin for links in the messages, e.g. https://degent.club. */
  siteUrl: string;
  source?: string;
  log?: Logger;
}

/** Block height from the `confirmed` timeline event ("block 912345"), if the order has one. */
export function blockHeightOf(order: Pick<Order, 'timeline'> | null): number | null {
  if (!order) return null;
  for (let i = order.timeline.length - 1; i >= 0; i--) {
    const e = order.timeline[i]!;
    if (e.status !== 'confirmed') continue;
    const m = /block (\d+)/.exec(e.detail ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

/** The human copy for each notifying status. `order` is the order as stored when the event is handled. */
export function renderOrderNotification(event: Pick<OrderStatusEvent, 'status' | 'orderId'>, order: Order | null, siteUrl: string): RenderedMessage {
  const site = siteUrl.replace(/\/+$/, '');
  const track = `${site}/track/${encodeURIComponent(event.orderId)}`;
  const ref = `Order ${event.orderId}`;
  switch (event.status as NotifyStatus) {
    case 'member_review':
      return {
        subject: 'Your Degent is with the club',
        text: `Your payment is confirmed on chain and your Degent is now with the club: the members are reviewing it.\n\nFollow the vote: ${track}\n\n${ref}`,
      };
    case 'declined':
      return {
        subject: 'The members declined your Degent',
        text:
          'The club voted not to admit this piece. Nothing is lost: your funding sits in the commit output and only your one-time key can spend it.\n\n' +
          `Open ${track} on the device you paid on and use your recovery passphrase to reveal it without the parent link. The inscription lands in your ordinals address; it is simply not a Degent.\n\n${ref}`,
      };
    case 'rescue_available':
      return {
        subject: 'Self-rescue is available for your Degent',
        text:
          'Your Degent has not been revealed in time, so self-rescue is open. Your recovery bundle holds your one-time key, encrypted with your recovery passphrase.\n\n' +
          `Open ${track} on the device you paid on, enter the passphrase, and your browser signs a reveal to your ordinals address.\n\n${ref}`,
      };
    case 'delivered': {
      const n = order?.degentNumber ?? null;
      const height = blockHeightOf(order);
      const block = height !== null ? `, block ${height}` : '';
      if (n !== null && !order?.rescued) {
        return {
          subject: `Degent #${n} joined the club${block}`,
          text: `Degent #${n} joined the club${block}. Welcome, gentleman.\n\n${site}/collection/${n}\n\n${ref}`,
        };
      }
      return {
        subject: `Your inscription landed${block}`,
        text: `Your inscription is on chain${block}, in your ordinals address (without the parent link).\n\n${track}\n\n${ref}`,
      };
    }
    default:
      return { subject: `Degent order update: ${event.status}`, text: `${track}\n\n${ref}` };
  }
}

export function subscriptionId(orderId: string, channel: NotifyChannel, address: string): string {
  return `sub_${createHash('sha256').update(`${orderId}\u0000${channel}\u0000${address.toLowerCase()}`).digest('hex').slice(0, 24)}`;
}

export class OrderNotificationService {
  /** Permanent failures on first attempt, across all orders; later retry failures are logged (onOutcome). Addresses stay out of logs. */
  readonly failed: FailedNotification[] = [];
  private readonly log: Logger;
  private readonly deliveryLog: DeliveryLog;
  private readonly live = new Set<Notifier>();

  constructor(private readonly d: NotificationServiceDeps) {
    this.log = d.log ?? silentLogger;
    this.deliveryLog = d.deliveryLog ?? new InMemoryDeliveryLog();
  }

  /** Channels this deployment can deliver to. */
  availableChannels(): NotifyChannel[] {
    return CHANNELS.filter((c) => (c === 'email' ? !!this.d.email : !!this.d.telegram));
  }

  private channelsFor(order: Order | null): NotificationChannel[] {
    const render = (e: EventEnvelope): RenderedMessage => renderOrderNotification(e.data as OrderStatusEvent, order, this.d.siteUrl);
    const out: NotificationChannel[] = [];
    if (this.d.email) out.push(new EmailChannel(this.d.email, render));
    if (this.d.telegram) out.push(new TelegramChannel(this.d.telegram, render));
    return out;
  }

  private notifier(order: Order | null): Notifier {
    return new Notifier({
      channels: this.channelsFor(order),
      deliveryLog: this.deliveryLog,
      ...(this.d.retryClock ? { clock: this.d.retryClock } : {}),
      onOutcome: (o) => {
        if (o.status === 'failed') this.log.warn('order notification failed', { subscriptionId: o.subscriptionId, channel: o.channel, attempt: o.attempt, error: o.error });
      },
    });
  }

  /** POST /v1/orders/{id}/subscriptions. Authorised with the order token. */
  async subscribe(orderId: string, authorization: string | undefined, body: unknown): Promise<OrderSubscription> {
    const record = await this.d.orders.authorize(orderId, authorization);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const channel = b.channel as NotifyChannel;
    if (!CHANNELS.includes(channel)) throw invalid(`channel must be one of ${CHANNELS.join(', ')}`);
    const address = typeof b.address === 'string' ? b.address.trim() : '';
    if (address.length === 0 || address.length > 254) throw invalid('address must be 1-254 characters');
    for (const k of Object.keys(b)) if (k !== 'channel' && k !== 'address') throw invalid(`unknown field ${k}`);
    if (!this.availableChannels().includes(channel))
      throw new DomainError('channel_unavailable', 503, `${channel} notifications are not configured on this mint`);
    const probe = this.channelsFor(null).find((c) => c.kind === KIND[channel])!;
    try {
      probe.validateTarget?.(address);
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : String(e));
    }
    if (CLOSED.includes(record.status)) throw conflict(`order is ${record.status}; nothing left to notify`, { status: record.status });

    const id = subscriptionId(orderId, channel, address);
    const existing = await this.d.subscriptions.listByOrder(orderId);
    if (!existing.some((s) => s.id === id) && existing.length >= MAX_SUBSCRIPTIONS_PER_ORDER)
      throw invalid(`at most ${MAX_SUBSCRIPTIONS_PER_ORDER} subscriptions per order`);
    const saved = await this.d.subscriptions.add({ id, orderId, channel, address, createdAt: this.d.clock.now().toISOString() });
    this.log.info('order subscription added', { orderId, subscriptionId: saved.id, channel });
    return toPublic(saved);
  }

  /** Handle one order-status event. Silent (no I/O) for statuses outside NOTIFY_STATUSES. */
  async handle(event: OrderStatusEvent): Promise<DeliveryOutcome[]> {
    if (!(NOTIFY_STATUSES as readonly string[]).includes(event.status)) return [];
    const subs = await this.d.subscriptions.listByOrder(event.orderId);
    if (subs.length === 0) return [];
    const order = await this.d.orders.getOrder(event.orderId).catch(() => null);
    const notifier = this.notifier(order);
    for (const s of subs) {
      if (!this.availableChannels().includes(s.channel)) continue;
      await notifier.subscribe({ id: s.id, subscriberId: `order:${s.orderId}`, channel: KIND[s.channel], target: s.address, topics: TOPICS });
    }
    const outcomes = await notifier.handle(toPlatformEnvelope(event, this.d.source ?? MINT_EVENT_SOURCE));
    this.failed.push(...notifier.failed);
    // Keep notifiers with retries in flight so stop() can cancel them; forget the rest.
    for (const n of this.live) if (n.pendingRetries === 0) this.live.delete(n);
    if (notifier.pendingRetries > 0) this.live.add(notifier);
    return outcomes;
  }

  /** Follow an in-process bus (MemoryEventBus.subscribe). Returns the unsubscribe function. */
  attach(bus: { subscribe(fn: (e: OrderStatusEvent) => void): () => void }): () => void {
    return bus.subscribe((e) => {
      this.handle(e).catch((err) => this.log.error('order notification handling failed', { orderId: e.orderId, status: e.status, error: err instanceof Error ? err.message : String(err) }));
    });
  }

  /** Cancel pending retries (shutdown). */
  stop(): void {
    for (const n of this.live) n.stop();
    this.live.clear();
  }
}

function toPublic(s: OrderSubscriptionRecord): OrderSubscription {
  return { id: s.id, orderId: s.orderId, channel: s.channel, address: s.address, events: [...NOTIFY_STATUSES], createdAt: s.createdAt };
}
