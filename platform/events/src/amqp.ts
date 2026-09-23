import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.js';
import { NonRetryableError, type EventBus, type EventHandler, type SubscribeOptions, type Subscription } from './bus.js';
import { systemClock, type Clock } from './clock.js';
import { assertEnvelope, type EventEnvelope } from './envelope.js';
import { isPattern, templateToPattern } from './match.js';
import type { TopicRegistry } from './topics.js';

/**
 * The subset of an amqplib `ConfirmChannel` the adapter uses. amqplib's channel satisfies it structurally, so
 * this package needs no amqplib dependency (the service that binds RabbitMQ owns that dependency):
 *
 *   const conn = await amqplib.connect(url);            // amqplib ^0.10
 *   const channel = await conn.createConfirmChannel();  // confirms => publish() awaits broker acks
 *   const bus = new AmqpBusAdapter({ channel, service: 'degent-mint' });
 *   await bus.init();
 */
export interface AmqpMessage {
  content: Uint8Array;
  fields: { deliveryTag: number; redelivered: boolean; routingKey: string; exchange: string };
  properties: {
    messageId?: string;
    contentType?: string;
    type?: string;
    timestamp?: number;
    appId?: string;
    headers?: Record<string, unknown>;
  };
}

export interface AmqpPublishOptions {
  persistent?: boolean;
  messageId?: string;
  contentType?: string;
  type?: string;
  timestamp?: number;
  appId?: string;
  headers?: Record<string, unknown>;
}

export interface AmqpChannel {
  assertExchange(exchange: string, type: 'topic' | 'direct' | 'fanout' | 'headers', options?: { durable?: boolean }): Promise<unknown>;
  assertQueue(queue: string, options?: { durable?: boolean; arguments?: Record<string, unknown> }): Promise<{ queue: string }>;
  bindQueue(queue: string, source: string, pattern: string): Promise<unknown>;
  /** Returns false when the channel's write buffer is full (amqplib still queues the message). */
  publish(exchange: string, routingKey: string, content: Buffer, options?: AmqpPublishOptions): boolean;
  consume(queue: string, onMessage: (msg: AmqpMessage | null) => void, options?: { noAck?: boolean }): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  ack(message: AmqpMessage): void;
  nack(message: AmqpMessage, allUpTo?: boolean, requeue?: boolean): void;
  prefetch?(count: number): Promise<unknown>;
  /** Present on confirm channels; awaited after each publish. */
  waitForConfirms?(): Promise<void>;
}

export interface AmqpBusOptions {
  channel: AmqpChannel;
  /** Component name; prefixes default queue names (`<service>.<pattern>`). */
  service: string;
  /** Topic exchange (default `bsh.events`). Dead letters go to `<exchange>.dlx`. */
  exchange?: string;
  registry?: TopicRegistry;
  clock?: Clock;
  prefetch?: number;
  defaultMaxAttempts?: number;
  defaultBackoff?: BackoffPolicy;
  onError?: (info: { queue: string; routingKey: string; attempt: number; error: unknown; deadLettered: boolean }) => void;
}

export const CLOUDEVENTS_JSON = 'application/cloudevents+json';
export const ATTEMPT_HEADER = 'x-bsh-attempt';

/**
 * `EventBus` over RabbitMQ, CloudEvents AMQP binding in STRUCTURED mode: the body is the whole JSON envelope,
 * `content-type: application/cloudevents+json`, routing key = `type`, `message-id` = `id`, persistent delivery.
 *
 * Topology per subscription (queue `q`): durable queue bound to the topic exchange with the subscription
 * pattern; `x-dead-letter-exchange = <exchange>.dlx`, `x-dead-letter-routing-key = q`; a `q.dlq` queue bound
 * on the DLX collects dead letters.
 *
 * Failure handling: a failed handler is retried after backoff by republishing the message to `q` through the
 * default exchange with `x-bsh-attempt + 1`, then acking the original (ack-after-republish keeps at-least-once).
 * After `maxAttempts`, on `NonRetryableError`, or on an unparseable/invalid message it is `nack`ed without
 * requeue, so the broker moves it to `q.dlq`. Retries wait in-process and hold a prefetch slot meanwhile; for
 * long backoffs, swap in TTL retry queues (see README).
 */
export class AmqpBusAdapter implements EventBus {
  private readonly ch: AmqpChannel;
  private readonly exchange: string;
  private readonly dlx: string;
  private readonly clock: Clock;
  private readonly timers = new Set<unknown>();
  private initialised: Promise<void> | null = null;

  constructor(private readonly o: AmqpBusOptions) {
    this.ch = o.channel;
    this.exchange = o.exchange ?? 'bsh.events';
    this.dlx = `${this.exchange}.dlx`;
    this.clock = o.clock ?? systemClock;
  }

  /** Declare exchanges (idempotent). Called lazily by publish/subscribe. */
  init(): Promise<void> {
    this.initialised ??= (async () => {
      await this.ch.assertExchange(this.exchange, 'topic', { durable: true });
      await this.ch.assertExchange(this.dlx, 'direct', { durable: true });
      if (this.o.prefetch !== 0) await this.ch.prefetch?.(this.o.prefetch ?? 16);
    })();
    return this.initialised;
  }

  async publish(event: EventEnvelope): Promise<void> {
    assertEnvelope(event);
    this.o.registry?.assertValid(event);
    await this.init();
    this.ch.publish(this.exchange, event.type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      messageId: event.id,
      contentType: CLOUDEVENTS_JSON,
      type: event.type,
      appId: event.source,
      timestamp: Math.floor(Date.parse(event.time) / 1000),
      headers: event.traceparent ? { traceparent: event.traceparent } : {},
    });
    await this.ch.waitForConfirms?.();
  }

  async subscribe<T = unknown>(pattern: string, handler: EventHandler<T>, opts: SubscribeOptions = {}): Promise<Subscription> {
    const binding = templateToPattern(pattern);
    if (!isPattern(binding)) throw new Error(`invalid subscription pattern "${pattern}"`);
    await this.init();
    const queue = opts.name ?? `${this.o.service}.${binding.replace(/\*/g, 'any').replace(/#/g, 'all')}`;
    const maxAttempts = opts.maxAttempts ?? this.o.defaultMaxAttempts ?? 5;
    const backoff = opts.backoff ?? this.o.defaultBackoff ?? DEFAULT_BACKOFF;

    await this.ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': this.dlx, 'x-dead-letter-routing-key': queue },
    });
    await this.ch.bindQueue(queue, this.exchange, binding);
    await this.ch.assertQueue(`${queue}.dlq`, { durable: true });
    await this.ch.bindQueue(`${queue}.dlq`, this.dlx, queue);

    const onMessage = async (msg: AmqpMessage | null): Promise<void> => {
      if (msg === null) return; // consumer cancelled by broker
      const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1) || 1;
      let event: EventEnvelope;
      try {
        event = JSON.parse(new TextDecoder().decode(msg.content)) as EventEnvelope;
        assertEnvelope(event);
        this.o.registry?.assertValid(event);
      } catch (error) {
        this.o.onError?.({ queue, routingKey: msg.fields.routingKey, attempt, error, deadLettered: true });
        this.ch.nack(msg, false, false);
        return;
      }
      try {
        await handler(event as EventEnvelope<T>, { attempt, subscription: queue, redelivered: msg.fields.redelivered || attempt > 1 });
        this.ch.ack(msg);
      } catch (error) {
        const dead = error instanceof NonRetryableError || attempt >= maxAttempts;
        this.o.onError?.({ queue, routingKey: msg.fields.routingKey, attempt, error, deadLettered: dead });
        if (dead) {
          this.ch.nack(msg, false, false);
          return;
        }
        const h = this.clock.setTimeout(() => {
          this.timers.delete(h);
          this.ch.publish('', queue, Buffer.from(msg.content), {
            ...msg.properties,
            persistent: true,
            headers: { ...(msg.properties.headers ?? {}), [ATTEMPT_HEADER]: attempt + 1 },
          });
          void Promise.resolve(this.ch.waitForConfirms?.()).then(
            () => this.ch.ack(msg),
            () => this.ch.nack(msg, false, true), // republish unconfirmed: let the broker redeliver
          );
        }, backoffDelay(attempt, backoff));
        this.timers.add(h);
      }
    };

    const { consumerTag } = await this.ch.consume(queue, (m) => void onMessage(m), { noAck: false });
    return {
      name: queue,
      pattern: binding,
      unsubscribe: async () => {
        await this.ch.cancel(consumerTag);
      },
    };
  }

  /** Stops pending retries; their messages stay unacked and the broker redelivers them after the channel closes. */
  async close(): Promise<void> {
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
  }
}
