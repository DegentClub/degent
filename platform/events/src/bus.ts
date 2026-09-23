import type { BackoffPolicy } from './backoff.js';
import type { EventEnvelope } from './envelope.js';
import type { Topic } from './topics.js';

export interface DeliveryContext {
  /** 1-based delivery attempt for this subscriber. */
  attempt: number;
  /** Subscription (queue) name. */
  subscription: string;
  /** True when the broker says this message may have been seen before. */
  redelivered: boolean;
}

export type EventHandler<T = unknown> = (event: EventEnvelope<T>, ctx: DeliveryContext) => Promise<void> | void;

export interface SubscribeOptions {
  /** Durable subscriber name (AMQP queue). Defaults to a generated name. Two subscriptions with the same
   *  name compete for messages (work queue); different names each get a copy (fan-out). */
  name?: string;
  /** Total delivery attempts before dead-lettering (default 5). */
  maxAttempts?: number;
  backoff?: BackoffPolicy;
}

export interface Subscription {
  readonly name: string;
  /** AMQP binding pattern (`*` = one word, `#` = zero or more). */
  readonly pattern: string;
  unsubscribe(): Promise<void>;
}

/**
 * Publish/subscribe over topic names with AMQP topic-exchange semantics. Delivery is AT LEAST ONCE:
 * handlers must be idempotent (see `idempotent()`), keyed on `(source, id)`.
 * A handler signals failure by throwing; it is retried with backoff and dead-lettered after `maxAttempts`.
 * Throw `NonRetryableError` to dead-letter immediately (poison message).
 */
export interface EventBus {
  publish(event: EventEnvelope): Promise<void>;
  /** `pattern` may use `*` / `#` wildcards or a topic template (`block.indexed.{network}`). */
  subscribe<T = unknown>(pattern: string, handler: EventHandler<T>, opts?: SubscribeOptions): Promise<Subscription>;
  close?(): Promise<void>;
}

export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

export interface DeadLetter {
  event: EventEnvelope;
  subscription: string;
  attempts: number;
  error: string;
  at: string;
}

/** Typed subscription to every instance of a topic (`block.indexed.{network}` → all networks). */
export function subscribeTopic<T>(bus: EventBus, topic: Topic<T>, handler: EventHandler<T>, opts?: SubscribeOptions): Promise<Subscription> {
  return bus.subscribe<T>(topic.pattern, handler, opts);
}

/** Seen-set port for consumer de-duplication. Production: a table with a unique key and TTL. */
export interface DedupeStore {
  has(key: string): Promise<boolean> | boolean;
  add(key: string): Promise<void> | void;
}

/** Bounded in-memory seen-set (FIFO eviction). */
export class MemoryDedupeStore implements DedupeStore {
  private readonly keys = new Set<string>();
  constructor(private readonly capacity = 10_000) {}
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(key: string): void {
    this.keys.add(key);
    if (this.keys.size > this.capacity) this.keys.delete(this.keys.values().next().value as string);
  }
}

/**
 * Wrap a handler so each `(source, id)` is processed once per store. The key is recorded only after the handler
 * succeeds, so failed attempts are retried. For exactly-once effects, record the key in the same transaction as
 * the handler's writes instead.
 */
export function idempotent<T>(handler: EventHandler<T>, store: DedupeStore = new MemoryDedupeStore()): EventHandler<T> {
  return async (event, ctx) => {
    const key = `${event.source}\u0000${event.id}`;
    if (await store.has(key)) return;
    await handler(event, ctx);
    await store.add(key);
  };
}
