import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.js';
import type { DeadLetter, EventBus, EventHandler, SubscribeOptions, Subscription } from './bus.js';
import { NonRetryableError } from './bus.js';
import { systemClock, type Clock } from './clock.js';
import { assertEnvelope, type EventEnvelope } from './envelope.js';
import { isPattern, matchesPattern, templateToPattern } from './match.js';
import type { TopicRegistry } from './topics.js';

export interface InMemoryBusOptions {
  /** When set, `publish` rejects unknown topics and invalid payloads. */
  registry?: TopicRegistry;
  clock?: Clock;
  defaultMaxAttempts?: number;
  defaultBackoff?: BackoffPolicy;
  random?: () => number;
  /** Structured log sink for handler failures (default: silent). */
  onError?: (info: { subscription: string; event: EventEnvelope; attempt: number; error: unknown; willRetry: boolean }) => void;
}

interface Sub {
  name: string;
  pattern: string;
  handler: EventHandler;
  maxAttempts: number;
  backoff: BackoffPolicy;
  active: boolean;
  /** Round-robin members for competing consumers sharing a name. */
  members: EventHandler[];
  rr: number;
}

/**
 * In-process `EventBus` for dev and tests. Semantics mirror the RabbitMQ adapter:
 * topic-exchange routing, one copy per subscription name (competing consumers share a name),
 * at-least-once with per-subscription retries on the injected clock, dead letters after `maxAttempts`.
 *
 * `publish` resolves after every matching subscription's FIRST attempt has settled; retries run later on the clock.
 * Events are cloned per delivery (structuredClone) so handlers cannot mutate each other's copy.
 */
export class InMemoryBus implements EventBus {
  readonly deadLetters: DeadLetter[] = [];
  private readonly subs = new Map<string, Sub>();
  private readonly clock: Clock;
  private readonly timers = new Set<unknown>();
  private seq = 0;
  private closed = false;

  constructor(private readonly opts: InMemoryBusOptions = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  /** Retries scheduled but not yet run. */
  get pendingRetries(): number {
    return this.timers.size;
  }

  async publish(event: EventEnvelope): Promise<void> {
    if (this.closed) throw new Error('bus closed');
    assertEnvelope(event);
    this.opts.registry?.assertValid(event);
    const targets = [...this.subs.values()].filter((s) => s.active && matchesPattern(s.pattern, event.type));
    await Promise.allSettled(targets.map((s) => this.deliver(s, event, 1)));
  }

  async subscribe<T = unknown>(pattern: string, handler: EventHandler<T>, o: SubscribeOptions = {}): Promise<Subscription> {
    const binding = templateToPattern(pattern);
    if (!isPattern(binding)) throw new Error(`invalid subscription pattern "${pattern}"`);
    const name = o.name ?? `sub-${++this.seq}`;
    const existing = this.subs.get(name);
    if (existing) {
      if (existing.pattern !== binding) throw new Error(`subscription ${name} already bound to ${existing.pattern}`);
      existing.members.push(handler as EventHandler);
    } else {
      const sub: Sub = {
        name,
        pattern: binding,
        handler: async (e, ctx) => {
          const s = this.subs.get(name)!;
          const h = s.members[s.rr++ % s.members.length]!;
          await h(e, ctx);
        },
        maxAttempts: o.maxAttempts ?? this.opts.defaultMaxAttempts ?? 5,
        backoff: o.backoff ?? this.opts.defaultBackoff ?? DEFAULT_BACKOFF,
        active: true,
        members: [handler as EventHandler],
        rr: 0,
      };
      this.subs.set(name, sub);
    }
    const h = handler as EventHandler;
    return {
      name,
      pattern: binding,
      unsubscribe: async () => {
        const s = this.subs.get(name);
        if (!s) return;
        s.members = s.members.filter((m) => m !== h);
        if (s.members.length === 0) {
          s.active = false;
          this.subs.delete(name);
        }
      },
    };
  }

  /** Re-deliver dead letters (optionally filtered) as fresh attempts; returns how many were redriven. */
  async redrive(filter: (d: DeadLetter) => boolean = () => true): Promise<number> {
    const picked = this.deadLetters.filter(filter);
    for (const d of picked) this.deadLetters.splice(this.deadLetters.indexOf(d), 1);
    await Promise.allSettled(
      picked.map((d) => {
        const s = this.subs.get(d.subscription);
        if (!s) {
          this.deadLetters.push(d);
          return Promise.resolve();
        }
        return this.deliver(s, d.event, 1);
      }),
    );
    return picked.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
    this.subs.clear();
  }

  private async deliver(s: Sub, event: EventEnvelope, attempt: number): Promise<void> {
    if (!s.active) return;
    try {
      await s.handler(structuredClone(event), { attempt, subscription: s.name, redelivered: attempt > 1 });
    } catch (error) {
      const permanent = error instanceof NonRetryableError;
      const willRetry = !permanent && attempt < s.maxAttempts;
      this.opts.onError?.({ subscription: s.name, event, attempt, error, willRetry });
      if (!willRetry) {
        this.deadLetters.push({
          event,
          subscription: s.name,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
          at: new Date(this.clock.now()).toISOString(),
        });
        return;
      }
      const handle = this.clock.setTimeout(() => {
        this.timers.delete(handle);
        void this.deliver(s, event, attempt + 1);
      }, backoffDelay(attempt, s.backoff, this.opts.random));
      this.timers.add(handle);
    }
  }
}
