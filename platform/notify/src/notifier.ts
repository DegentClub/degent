import { createHash } from 'node:crypto';
import {
  backoffDelay,
  isPattern,
  matchesPattern,
  systemClock,
  templateToPattern,
  type Clock,
  type EventBus,
  type EventEnvelope,
  type SubscribeOptions,
  type Subscription,
} from '@bsh/events';
import type { ChannelKind, DeliveryResult, Notification, NotificationChannel, NotificationSubscription, RetryPolicy } from './types.js';

type Sub = NotificationSubscription & { id: string };

/** Subscription store port. Production: a table indexed by pattern; `matching` may pre-filter by prefix. */
export interface SubscriptionStore {
  add(sub: Sub): Promise<void>;
  remove(id: string): Promise<boolean>;
  /** Active subscriptions with at least one topic pattern matching `type`. */
  matching(type: string): Promise<Sub[]>;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly subs = new Map<string, Sub>();
  async add(sub: Sub): Promise<void> {
    this.subs.set(sub.id, sub);
  }
  async remove(id: string): Promise<boolean> {
    return this.subs.delete(id);
  }
  async matching(type: string): Promise<Sub[]> {
    return [...this.subs.values()].filter((s) => s.active !== false && s.topics.some((t) => matchesPattern(templateToPattern(t), type)));
  }
}

/** Records successful deliveries so re-handling the same event (bus redelivery) does not notify twice. */
export interface DeliveryLog {
  delivered(idempotencyKey: string): Promise<boolean>;
  record(idempotencyKey: string): Promise<void>;
}

export class InMemoryDeliveryLog implements DeliveryLog {
  private readonly keys = new Set<string>();
  async delivered(k: string): Promise<boolean> {
    return this.keys.has(k);
  }
  async record(k: string): Promise<void> {
    this.keys.add(k);
  }
}

export type DeliveryStatus = 'delivered' | 'retrying' | 'failed' | 'duplicate' | 'no_channel';

export interface DeliveryOutcome {
  subscriptionId: string;
  subscriberId: string;
  channel: ChannelKind;
  idempotencyKey: string;
  status: DeliveryStatus;
  attempt: number;
  error?: string;
}

export interface FailedNotification {
  notification: Notification;
  error: string;
  at: string;
}

export interface NotifierOptions {
  channels: readonly NotificationChannel[];
  subscriptions?: SubscriptionStore;
  deliveryLog?: DeliveryLog;
  clock?: Clock;
  /** Per-kind override of the channel's own retry policy. */
  retry?: Partial<Record<ChannelKind, RetryPolicy>>;
  random?: () => number;
  /** Every attempt's outcome (metrics/logging hook). */
  onOutcome?: (o: DeliveryOutcome) => void;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, backoff: { initialMs: 1_000, factor: 2, maxMs: 300_000 } };

/** `sha256(subscriptionId \0 source \0 eventId)` in hex: stable per (subscription, event), opaque to receivers. */
export function idempotencyKeyFor(subscriptionId: string, event: Pick<EventEnvelope, 'source' | 'id'>): string {
  return createHash('sha256').update(`${subscriptionId}\u0000${event.source}\u0000${event.id}`).digest('hex');
}

/**
 * Fans each event out to every matching subscription over its channel. Each (subscription, event) pair is
 * delivered and retried independently (exponential backoff on the injected clock, `Retry-After` honoured), so a
 * dead webhook never delays or duplicates email to someone else. After `maxAttempts` or a permanent failure the
 * notification lands in `failed` (dead letters).
 *
 * `handle` resolves after the first attempt of every delivery. Retries live in process memory: run the Notifier
 * behind a durable bus subscription (see `attach`) and a durable `DeliveryLog`, so a restart re-handles the event
 * and the log suppresses the deliveries that already succeeded.
 */
export class Notifier {
  readonly failed: FailedNotification[] = [];
  private readonly channels = new Map<ChannelKind, NotificationChannel>();
  private readonly subs: SubscriptionStore;
  private readonly log: DeliveryLog;
  private readonly clock: Clock;
  private readonly timers = new Set<unknown>();

  constructor(private readonly o: NotifierOptions) {
    for (const c of o.channels) {
      if (this.channels.has(c.kind)) throw new Error(`duplicate channel ${c.kind}`);
      this.channels.set(c.kind, c);
    }
    this.subs = o.subscriptions ?? new InMemorySubscriptionStore();
    this.log = o.deliveryLog ?? new InMemoryDeliveryLog();
    this.clock = o.clock ?? systemClock;
  }

  get pendingRetries(): number {
    return this.timers.size;
  }

  /** Validate and store a subscription; returns its id. */
  async subscribe(sub: NotificationSubscription): Promise<string> {
    if (!sub.subscriberId) throw new Error('subscriberId required');
    if (sub.topics.length === 0) throw new Error('at least one topic pattern required');
    for (const t of sub.topics) if (!isPattern(templateToPattern(t))) throw new Error(`invalid topic pattern "${t}"`);
    const channel = this.channels.get(sub.channel);
    if (!channel) throw new Error(`no channel "${sub.channel}" configured`);
    channel.validateTarget?.(sub.target);
    const id = sub.id ?? `${sub.subscriberId}:${sub.channel}:${sub.target}`;
    await this.subs.add({ ...sub, id, topics: [...sub.topics] });
    return id;
  }

  unsubscribe(id: string): Promise<boolean> {
    return this.subs.remove(id);
  }

  /** Fan an event out to all matching subscriptions. */
  async handle(event: EventEnvelope): Promise<DeliveryOutcome[]> {
    const subs = await this.subs.matching(event.type);
    return Promise.all(
      subs.map(async (sub) => {
        const idempotencyKey = idempotencyKeyFor(sub.id, event);
        if (await this.log.delivered(idempotencyKey)) return this.outcome(sub, idempotencyKey, 'duplicate', 0);
        return this.attempt({ event, subscription: sub, idempotencyKey, attempt: 1 });
      }),
    );
  }

  /** Consume every event from a bus (durable subscription `name`). */
  attach(bus: EventBus, pattern = '#', opts: SubscribeOptions = { name: 'notify' }): Promise<Subscription> {
    return bus.subscribe(pattern, async (e) => {
      await this.handle(e);
    }, opts);
  }

  stop(): void {
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
  }

  private policy(kind: ChannelKind): RetryPolicy {
    return this.o.retry?.[kind] ?? this.channels.get(kind)?.retry ?? DEFAULT_RETRY;
  }

  private outcome(sub: Sub, key: string, status: DeliveryStatus, attempt: number, error?: string): DeliveryOutcome {
    const o: DeliveryOutcome = { subscriptionId: sub.id, subscriberId: sub.subscriberId, channel: sub.channel, idempotencyKey: key, status, attempt };
    if (error !== undefined) o.error = error;
    this.o.onOutcome?.(o);
    return o;
  }

  private async attempt(n: Notification): Promise<DeliveryOutcome> {
    const sub = n.subscription;
    const channel = this.channels.get(sub.channel);
    if (!channel) return this.outcome(sub, n.idempotencyKey, 'no_channel', n.attempt);
    let r: DeliveryResult;
    try {
      r = await channel.send(n);
    } catch (e) {
      r = { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
    }
    if (r.ok) {
      await this.log.record(n.idempotencyKey);
      return this.outcome(sub, n.idempotencyKey, 'delivered', n.attempt);
    }
    const policy = this.policy(sub.channel);
    if (!r.retryable || n.attempt >= policy.maxAttempts) {
      this.failed.push({ notification: n, error: r.error, at: new Date(this.clock.now()).toISOString() });
      return this.outcome(sub, n.idempotencyKey, 'failed', n.attempt, r.error);
    }
    const delay = Math.max(backoffDelay(n.attempt, policy.backoff, this.o.random), Math.min(r.retryAfterMs ?? 0, policy.backoff.maxMs));
    const h = this.clock.setTimeout(() => {
      this.timers.delete(h);
      void this.attempt({ ...n, attempt: n.attempt + 1 });
    }, delay);
    this.timers.add(h);
    return this.outcome(sub, n.idempotencyKey, 'retrying', n.attempt, r.error);
  }
}
