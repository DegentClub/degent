import type { BackoffPolicy, EventEnvelope } from '@bsh/events';

export type ChannelKind = 'webhook' | 'email' | 'telegram' | (string & {});

/**
 * Who wants which events where. `topics` are subscription patterns: exact names, AMQP wildcards
 * (`degent.mint.order.*`, `block.#`) or topic templates (`block.indexed.{network}`).
 */
export interface NotificationSubscription {
  /** Stable id; defaults to `<subscriberId>:<channel>:<target>`. Part of the idempotency key. */
  id?: string;
  subscriberId: string;
  channel: ChannelKind;
  /** Webhook URL, email address or Telegram chat id. */
  target: string;
  topics: readonly string[];
  /** Paused subscriptions match nothing. */
  active?: boolean;
}

export interface Notification {
  event: EventEnvelope;
  subscription: Required<Pick<NotificationSubscription, 'id'>> & NotificationSubscription;
  /** Stable across retries and re-handling of the same event: receivers de-duplicate on it. */
  idempotencyKey: string;
  /** 1-based. */
  attempt: number;
}

export type DeliveryResult =
  | { ok: true; status?: number }
  | { ok: false; retryable: boolean; error: string; status?: number; retryAfterMs?: number };

export interface RetryPolicy {
  maxAttempts: number;
  backoff: BackoffPolicy;
}

/** Channel port. `send` must not throw for delivery failures; it returns `{ ok: false, retryable }`. */
export interface NotificationChannel {
  readonly kind: ChannelKind;
  /** Channel default; the Notifier's per-kind override wins. */
  readonly retry?: RetryPolicy;
  /** Throws when a target is unusable (called when a subscription is added). */
  validateTarget?(target: string): void;
  send(n: Notification): Promise<DeliveryResult>;
}

export interface RenderedMessage {
  subject: string;
  text: string;
}

/** Default human rendering of an event for email / chat. Products pass their own. */
export function renderEvent(event: EventEnvelope, maxChars = 3_500): RenderedMessage {
  const subject = `[bsh] ${event.type}${event.subject ? ` ${event.subject}` : ''}`;
  let data = JSON.stringify(event.data, null, 2) ?? 'null';
  const head = `${event.type}\nid: ${event.id}\nsource: ${event.source}\ntime: ${event.time}\n\n`;
  if (head.length + data.length > maxChars) data = `${data.slice(0, Math.max(0, maxChars - head.length - 2))}\n…`;
  return { subject, text: head + data };
}
