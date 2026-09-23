import { describe, expect, it } from 'vitest';
import {
  createEvent,
  idempotent,
  InMemoryBus,
  ManualClock,
  NonRetryableError,
  platformRegistry,
  collectionMinted,
  subscribeTopic,
  type EventEnvelope,
} from '../src/index.js';

const ev = (type: string, id = type) => createEvent({ source: 'urn:bsh:test', type, id, data: {} });
const backoff = { initialMs: 100, factor: 2, maxMs: 1_000 };

describe('InMemoryBus routing', () => {
  it('routes by wildcard pattern, one copy per subscription name, round-robin within a name', async () => {
    const bus = new InMemoryBus();
    const got: Record<string, string[]> = { all: [], blocks: [], mainnet: [], w1: [], w2: [] };
    await bus.subscribe('#', (e) => void got.all!.push(e.type));
    await bus.subscribe('block.indexed.{network}', (e) => void got.blocks!.push(e.type));
    await bus.subscribe('#.mainnet', (e) => void got.mainnet!.push(e.type));
    await bus.subscribe('batch.*', (e) => void got.w1!.push(e.id), { name: 'workers' });
    await bus.subscribe('batch.*', (e) => void got.w2!.push(e.id), { name: 'workers' });

    await bus.publish(ev('block.indexed.mainnet'));
    await bus.publish(ev('block.indexed.signet'));
    await bus.publish(ev('batch.created', 'b1'));
    await bus.publish(ev('batch.funded', 'b2'));

    expect(got.all).toHaveLength(4);
    expect(got.blocks).toEqual(['block.indexed.mainnet', 'block.indexed.signet']);
    expect(got.mainnet).toEqual(['block.indexed.mainnet']);
    expect([got.w1, got.w2]).toEqual([['b1'], ['b2']]);
    await expect(bus.subscribe('batch.#', () => {}, { name: 'workers' })).rejects.toThrow(/already bound/);
  });

  it('isolates handlers from each other (cloned events) and supports unsubscribe', async () => {
    const bus = new InMemoryBus();
    const seen: unknown[] = [];
    const s1 = await bus.subscribe<{ n?: number }>('x', (e) => {
      e.data.n = 1;
    });
    await bus.subscribe('x', (e) => void seen.push(e.data));
    await bus.publish(ev('x'));
    expect(seen).toEqual([{}]);
    await s1.unsubscribe();
    await bus.publish(ev('x', 'x2'));
    expect(seen).toHaveLength(2);
  });

  it('validates against the registry on publish', async () => {
    const bus = new InMemoryBus({ registry: platformRegistry() });
    await expect(bus.publish(ev('collection.minted'))).rejects.toThrow(/missing required/);
    await expect(bus.publish(ev('unknown.topic'))).rejects.toThrow(/unknown topic/);
    const got: string[] = [];
    await subscribeTopic(bus, collectionMinted, (e) => void got.push(e.data.inscriptionId));
    await bus.publish(
      collectionMinted.create({
        source: 'urn:bsh:degent-mint',
        data: { collectionId: 'degents', network: 'mainnet', inscriptionId: `${'a'.repeat(64)}i0`, txid: 'a'.repeat(64), mintedAt: '2026-09-23T00:00:00Z' },
      }),
    );
    expect(got).toEqual([`${'a'.repeat(64)}i0`]);
  });
});

describe('InMemoryBus retries and dead letters (fake clock)', () => {
  it('retries with exponential backoff per subscriber, then dead-letters', async () => {
    const clock = new ManualClock(Date.parse('2026-09-23T00:00:00Z'));
    const bus = new InMemoryBus({ clock, defaultBackoff: backoff });
    const attemptsAt: number[] = [];
    let healthy = 0;
    await bus.subscribe('x', () => {
      attemptsAt.push(clock.now());
      throw new Error('boom');
    }, { name: 'flaky', maxAttempts: 4 });
    await bus.subscribe('x', () => void healthy++, { name: 'healthy' });

    const t0 = clock.now();
    await bus.publish(ev('x'));
    expect(healthy).toBe(1); // a failing subscriber never blocks or duplicates others
    expect(attemptsAt).toHaveLength(1);
    expect(bus.pendingRetries).toBe(1);

    await clock.advance(99);
    expect(attemptsAt).toHaveLength(1);
    await clock.advance(1);
    expect(attemptsAt).toHaveLength(2);
    await clock.advance(10_000);
    expect(attemptsAt.map((t) => t - t0)).toEqual([0, 100, 300, 700]); // 100, 200, 400 ms gaps
    expect(bus.pendingRetries).toBe(0);
    expect(healthy).toBe(1);
    expect(bus.deadLetters).toHaveLength(1);
    expect(bus.deadLetters[0]).toMatchObject({ subscription: 'flaky', attempts: 4, error: 'boom', at: new Date(t0 + 700).toISOString() });
  });

  it('succeeds on a later attempt and reports attempt numbers', async () => {
    const clock = new ManualClock();
    const bus = new InMemoryBus({ clock, defaultBackoff: backoff });
    const ctxs: Array<[number, boolean]> = [];
    await bus.subscribe('x', (_e, ctx) => {
      ctxs.push([ctx.attempt, ctx.redelivered]);
      if (ctx.attempt < 3) throw new Error('transient');
    });
    await bus.publish(ev('x'));
    await clock.runAll();
    expect(ctxs).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect(bus.deadLetters).toEqual([]);
  });

  it('NonRetryableError dead-letters immediately; redrive re-delivers', async () => {
    const clock = new ManualClock();
    const bus = new InMemoryBus({ clock });
    let fixed = false;
    const ok: string[] = [];
    await bus.subscribe('x', (e) => {
      if (!fixed) throw new NonRetryableError('poison');
      ok.push(e.id);
    }, { name: 's' });
    await bus.publish(ev('x', 'p1'));
    expect(bus.pendingRetries).toBe(0);
    expect(bus.deadLetters.map((d) => [d.event.id, d.attempts])).toEqual([['p1', 1]]);
    fixed = true;
    expect(await bus.redrive()).toBe(1);
    expect(ok).toEqual(['p1']);
    expect(bus.deadLetters).toEqual([]);
  });

  it('idempotent() processes duplicate deliveries once but retries failures', async () => {
    const clock = new ManualClock();
    const bus = new InMemoryBus({ clock, defaultBackoff: backoff });
    const processed: string[] = [];
    let fail = true;
    await bus.subscribe(
      'x',
      idempotent((e: EventEnvelope) => {
        if (fail) {
          fail = false;
          throw new Error('once');
        }
        processed.push(e.id);
      }),
    );
    const e = ev('x', 'same-id');
    await bus.publish(e);
    await clock.runAll();
    await bus.publish(e); // duplicate (e.g. outbox republish)
    expect(processed).toEqual(['same-id']);
  });

  it('close() cancels pending retries', async () => {
    const clock = new ManualClock();
    const bus = new InMemoryBus({ clock });
    let n = 0;
    await bus.subscribe('x', () => {
      n++;
      throw new Error('x');
    });
    await bus.publish(ev('x'));
    await bus.close();
    await clock.advance(1e9);
    expect(n).toBe(1);
    await expect(bus.publish(ev('x'))).rejects.toThrow(/closed/);
  });
});
