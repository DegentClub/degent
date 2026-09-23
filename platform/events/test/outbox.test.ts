import { describe, expect, it } from 'vitest';
import {
  createEvent,
  idempotent,
  InMemoryBus,
  InMemoryOutboxStore,
  ManualClock,
  MemoryDedupeStore,
  OutboxPublisher,
  platformRegistry,
  type EventBus,
  type EventEnvelope,
} from '../src/index.js';

const ev = (id: string) => createEvent({ source: 'urn:bsh:test', type: 'x.happened', id, data: { id } });

function recordingBus(): EventBus & { sent: string[]; failNext: number } {
  const b = {
    sent: [] as string[],
    failNext: 0,
    async publish(e: EventEnvelope) {
      if (b.failNext > 0) {
        b.failNext--;
        throw new Error('broker down');
      }
      b.sent.push(e.id);
    },
    async subscribe(): Promise<never> {
      throw new Error('n/a');
    },
  };
  return b;
}

describe('OutboxPublisher', () => {
  it('relays staged events in order and marks them published', async () => {
    const clock = new ManualClock(1_000);
    const store = new InMemoryOutboxStore(clock);
    const bus = recordingBus();
    const outbox = new OutboxPublisher({ store, bus, clock });
    await outbox.enqueue([ev('a'), ev('b')]);
    await clock.advance(1);
    await outbox.enqueue(ev('c'));
    expect(await outbox.relayOnce()).toEqual({ published: 3, failed: 0 });
    expect(bus.sent).toEqual(['a', 'b', 'c']);
    expect(await outbox.relayOnce()).toEqual({ published: 0, failed: 0 });
    expect(store.unpublished()).toEqual([]);
  });

  it('append is idempotent on event id (retried producer transaction)', async () => {
    const store = new InMemoryOutboxStore(new ManualClock());
    const bus = recordingBus();
    const outbox = new OutboxPublisher({ store, bus });
    await outbox.enqueue(ev('a'));
    await outbox.enqueue(ev('a'));
    await outbox.relayOnce();
    expect(bus.sent).toEqual(['a']);
  });

  it('crash after publish, before markPublished: republished with the same id, consumer processes once', async () => {
    const clock = new ManualClock();
    const store = new InMemoryOutboxStore(clock);
    const bus = new InMemoryBus({ clock });
    const handled: string[] = [];
    const deliveries: string[] = [];
    const dedupe = new MemoryDedupeStore();
    await bus.subscribe('x.*', (e) => void deliveries.push(e.id));
    await bus.subscribe('x.*', idempotent((e) => void handled.push(e.id), dedupe), { name: 'consumer' });

    const realMark = store.markPublished.bind(store);
    let crash = true;
    store.markPublished = async (id, at) => {
      if (crash) {
        crash = false;
        throw new Error('process killed');
      }
      return realMark(id, at);
    };
    const outbox = new OutboxPublisher({ store, bus, clock, leaseMs: 5_000 });
    await outbox.enqueue(ev('a'));
    await expect(outbox.relayOnce()).rejects.toThrow(/killed/);
    // lease hides the row from other relays until it expires
    expect(await outbox.relayOnce()).toEqual({ published: 0, failed: 0 });
    await clock.advance(5_000);
    expect(await outbox.relayOnce()).toEqual({ published: 1, failed: 0 });
    expect(deliveries).toEqual(['a', 'a']); // at-least-once on the wire
    expect(handled).toEqual(['a']); // exactly-once effect at the consumer
  });

  it('concurrent relays (same instance or two instances) never double-publish', async () => {
    const clock = new ManualClock();
    const store = new InMemoryOutboxStore(clock);
    const bus = recordingBus();
    const r1 = new OutboxPublisher({ store, bus, clock });
    const r2 = new OutboxPublisher({ store, bus, clock });
    await r1.enqueue([ev('a'), ev('b'), ev('c')]);
    const results = await Promise.all([r1.relayOnce(), r1.relayOnce(), r2.relayOnce()]);
    expect(results.reduce((n, r) => n + r.published, 0)).toBe(3);
    expect([...bus.sent].sort()).toEqual(['a', 'b', 'c']);
  });

  it('backs off failed publishes and parks after maxAttempts', async () => {
    const clock = new ManualClock();
    const store = new InMemoryOutboxStore(clock);
    const bus = recordingBus();
    const errors: boolean[] = [];
    const outbox = new OutboxPublisher({
      store,
      bus,
      clock,
      maxAttempts: 3,
      backoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
      onError: (i) => errors.push(i.parked),
    });
    await outbox.enqueue(ev('a'));
    bus.failNext = 10;
    expect(await outbox.relayOnce()).toEqual({ published: 0, failed: 1 });
    expect(store.rows.get('a')).toMatchObject({ attempts: 1, nextAttemptAt: 100, lastError: 'broker down' });
    await clock.advance(99);
    expect((await outbox.relayOnce()).failed).toBe(0);
    await clock.advance(1);
    expect((await outbox.relayOnce()).failed).toBe(1); // next at 100 + 200
    await clock.advance(200);
    expect((await outbox.relayOnce()).failed).toBe(1);
    expect(store.rows.get('a')).toMatchObject({ attempts: 3, nextAttemptAt: null });
    expect(errors).toEqual([false, false, true]);
    await clock.advance(1e9);
    expect(await outbox.relayOnce()).toEqual({ published: 0, failed: 0 });
  });

  it('rejects invalid events at enqueue time (fails the producer transaction)', async () => {
    const outbox = new OutboxPublisher({ store: new InMemoryOutboxStore(), bus: recordingBus(), registry: platformRegistry() });
    await expect(outbox.enqueue(createEvent({ source: 's', type: 'collection.minted', data: {} }))).rejects.toThrow(/missing required/);
  });

  it('start()/stop() drive the relay loop on the clock', async () => {
    const clock = new ManualClock();
    const store = new InMemoryOutboxStore(clock);
    const bus = recordingBus();
    const outbox = new OutboxPublisher({ store, bus, clock, pollIntervalMs: 500 });
    outbox.start();
    await clock.advance(0);
    await outbox.enqueue(ev('a'));
    expect(bus.sent).toEqual([]);
    await clock.advance(500);
    expect(bus.sent).toEqual(['a']);
    outbox.stop();
    await outbox.enqueue(ev('b'));
    await clock.advance(5_000);
    expect(bus.sent).toEqual(['a']);
    expect(clock.pending).toBe(0);
  });
});
