import { backoffDelay, type BackoffPolicy } from './backoff.js';
import type { EventBus } from './bus.js';
import { systemClock, type Clock } from './clock.js';
import { assertEnvelope, type EventEnvelope } from './envelope.js';
import type { TopicRegistry } from './topics.js';

/**
 * Transactional outbox. The producer writes its state change AND the event row in one database transaction
 * (`OutboxStore.append(events, tx)`); a relay later reads unpublished rows and publishes them to the bus.
 * No event is lost when the broker is down, and no event is published for a rolled-back transaction.
 *
 * Delivery is at least once: a crash between `bus.publish` and `markPublished` republishes the row with the
 * SAME envelope id, so consumers de-duplicate on `(source, id)` (see `idempotent()`).
 */
export interface OutboxRecord {
  /** Envelope id; unique in the store. */
  id: string;
  event: EventEnvelope;
  createdAt: number;
  attempts: number;
  /** Epoch ms when the row may be (re)claimed; null = parked after `maxAttempts` (needs an operator). */
  nextAttemptAt: number | null;
  publishedAt: number | null;
  lastError: string | null;
}

/**
 * Store port. Postgres shape (see README): `claim` is
 * `UPDATE outbox SET next_attempt_at = $leaseUntil WHERE id IN (SELECT id FROM outbox WHERE published_at IS NULL
 *  AND next_attempt_at <= $now ORDER BY created_at LIMIT $limit FOR UPDATE SKIP LOCKED) RETURNING *`.
 */
export interface OutboxStore<Tx = unknown> {
  /** Insert rows inside the caller's transaction. Duplicate ids are ignored (idempotent append). */
  append(events: readonly EventEnvelope[], tx?: Tx): Promise<void>;
  /** Lease up to `limit` due, unpublished rows (oldest first) until `leaseUntil`, so concurrent relays skip them. */
  claim(limit: number, now: number, leaseUntil: number): Promise<OutboxRecord[]>;
  markPublished(id: string, at: number): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: number | null): Promise<void>;
}

export class InMemoryOutboxStore implements OutboxStore<never> {
  readonly rows = new Map<string, OutboxRecord>();
  constructor(private readonly clock: Clock = systemClock) {}

  async append(events: readonly EventEnvelope[]): Promise<void> {
    for (const e of events) assertEnvelope(e); // all-or-nothing
    for (const e of events) {
      if (this.rows.has(e.id)) continue;
      const now = this.clock.now();
      this.rows.set(e.id, { id: e.id, event: e, createdAt: now, attempts: 0, nextAttemptAt: now, publishedAt: null, lastError: null });
    }
  }

  async claim(limit: number, now: number, leaseUntil: number): Promise<OutboxRecord[]> {
    const due = [...this.rows.values()]
      .filter((r) => r.publishedAt === null && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    for (const r of due) r.nextAttemptAt = leaseUntil;
    return due.map((r) => ({ ...r }));
  }

  async markPublished(id: string, at: number): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.publishedAt = at;
  }

  async markFailed(id: string, error: string, nextAttemptAt: number | null): Promise<void> {
    const r = this.rows.get(id);
    if (!r) return;
    r.attempts += 1;
    r.lastError = error;
    r.nextAttemptAt = nextAttemptAt;
  }

  unpublished(): OutboxRecord[] {
    return [...this.rows.values()].filter((r) => r.publishedAt === null);
  }
}

export interface OutboxPublisherOptions<Tx> {
  store: OutboxStore<Tx>;
  bus: EventBus;
  registry?: TopicRegistry;
  clock?: Clock;
  batchSize?: number;
  /** How long a claimed row is hidden from other relays (must exceed a batch's publish time). */
  leaseMs?: number;
  pollIntervalMs?: number;
  backoff?: BackoffPolicy;
  /** Failed publishes before a row is parked (`nextAttemptAt = null`). */
  maxAttempts?: number;
  onError?: (info: { id: string; error: unknown; parked: boolean }) => void;
}

export interface RelayResult {
  published: number;
  failed: number;
}

export class OutboxPublisher<Tx = unknown> {
  private readonly clock: Clock;
  private running = false;
  private timer: unknown = null;
  private stopped = true;

  constructor(private readonly o: OutboxPublisherOptions<Tx>) {
    this.clock = o.clock ?? systemClock;
  }

  /** Stage events in the caller's transaction. Validates against the registry first, so bad events fail the tx. */
  async enqueue(events: EventEnvelope | readonly EventEnvelope[], tx?: Tx): Promise<void> {
    const list = Array.isArray(events) ? (events as readonly EventEnvelope[]) : [events as EventEnvelope];
    for (const e of list) this.o.registry?.assertValid(e);
    await this.o.store.append(list, tx);
  }

  /** One relay pass. Re-entrant calls while a pass runs return `{0, 0}` instead of double-publishing. */
  async relayOnce(): Promise<RelayResult> {
    if (this.running) return { published: 0, failed: 0 };
    this.running = true;
    const result: RelayResult = { published: 0, failed: 0 };
    try {
      const now = this.clock.now();
      const rows = await this.o.store.claim(this.o.batchSize ?? 100, now, now + (this.o.leaseMs ?? 30_000));
      for (const row of rows) {
        try {
          await this.o.bus.publish(row.event);
        } catch (error) {
          const attempts = row.attempts + 1;
          const parked = attempts >= (this.o.maxAttempts ?? 20);
          const next = parked ? null : this.clock.now() + backoffDelay(attempts, this.o.backoff ?? { initialMs: 1_000, factor: 2, maxMs: 300_000 });
          await this.o.store.markFailed(row.id, error instanceof Error ? error.message : String(error), next);
          this.o.onError?.({ id: row.id, error, parked });
          result.failed++;
          continue;
        }
        // If this throws (crash window) the lease expires and the row is republished with the same id.
        await this.o.store.markPublished(row.id, this.clock.now());
        result.published++;
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  /** Poll loop on the injected clock. Errors from the store are reported and the loop keeps going. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      this.timer = null;
      try {
        const r = await this.relayOnce();
        // drain quickly while there is backlog
        if (!this.stopped) this.timer = this.clock.setTimeout(tick, r.published > 0 ? 0 : (this.o.pollIntervalMs ?? 1_000));
      } catch (error) {
        this.o.onError?.({ id: '*', error, parked: false });
        if (!this.stopped) this.timer = this.clock.setTimeout(tick, this.o.pollIntervalMs ?? 1_000);
      }
    };
    this.timer = this.clock.setTimeout(tick, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
