import { createEvent, InMemoryBus, ManualClock, type EventEnvelope } from '@bsh/events';
import { describe, expect, it } from 'vitest';
import {
  ConsoleEmailSender,
  EmailChannel,
  idempotencyKeyFor,
  Notifier,
  WebhookChannel,
  type DeliveryResult,
  type FetchLike,
  type Notification,
  type NotificationChannel,
} from '../src/index.js';

const ev = (type: string, id = `${type}#1`) => createEvent({ source: 'urn:bsh:test', type, id, data: { type } });

/** Scripted channel: returns queued results, records every call. */
class ScriptedChannel implements NotificationChannel {
  calls: Array<{ target: string; type: string; attempt: number; key: string; at: number }> = [];
  constructor(
    readonly kind: string,
    private readonly clock: ManualClock,
    private readonly script: DeliveryResult[] = [],
  ) {}
  readonly retry = { maxAttempts: 4, backoff: { initialMs: 1_000, factor: 2, maxMs: 60_000 } };
  async send(n: Notification): Promise<DeliveryResult> {
    this.calls.push({ target: n.subscription.target, type: n.event.type, attempt: n.attempt, key: n.idempotencyKey, at: this.clock.now() });
    return this.script.shift() ?? { ok: true };
  }
}

describe('Notifier fan-out', () => {
  it('delivers each event to every matching subscription on its channel', async () => {
    const clock = new ManualClock();
    const hook = new ScriptedChannel('webhook', clock);
    const tg = new ScriptedChannel('telegram', clock);
    const n = new Notifier({ channels: [hook, tg], clock });
    await n.subscribe({ subscriberId: 'meter', channel: 'webhook', target: 'https://a', topics: ['block.indexed.{network}'] });
    await n.subscribe({ subscriberId: 'ops', channel: 'telegram', target: '-100', topics: ['degent.mint.order.failed', 'batch.failed'] });
    await n.subscribe({ subscriberId: 'mainnet-watch', channel: 'webhook', target: 'https://b', topics: ['#.mainnet'] });
    await n.subscribe({ subscriberId: 'paused', channel: 'webhook', target: 'https://c', topics: ['#'], active: false });

    const r1 = await n.handle(ev('block.indexed.mainnet'));
    expect(r1.map((o) => [o.subscriberId, o.status])).toEqual([
      ['meter', 'delivered'],
      ['mainnet-watch', 'delivered'],
    ]);
    await n.handle(ev('block.indexed.signet'));
    await n.handle(ev('degent.mint.order.failed'));
    await n.handle(ev('degent.mint.order.paid'));
    expect(await n.handle(ev('collection.minted'))).toEqual([]);

    expect(hook.calls.map((c) => `${c.target} ${c.type}`)).toEqual([
      'https://a block.indexed.mainnet',
      'https://b block.indexed.mainnet',
      'https://a block.indexed.signet',
    ]);
    expect(tg.calls.map((c) => c.type)).toEqual(['degent.mint.order.failed']);
    // idempotency key: per (subscription, event), stable, distinct across subscriptions
    expect(hook.calls[0]!.key).toBe(idempotencyKeyFor('meter:webhook:https://a', { source: 'urn:bsh:test', id: 'block.indexed.mainnet#1' }));
    expect(hook.calls[0]!.key).not.toBe(hook.calls[1]!.key);
  });

  it('suppresses duplicates of an already delivered event (bus redelivery)', async () => {
    const clock = new ManualClock();
    const hook = new ScriptedChannel('webhook', clock);
    const n = new Notifier({ channels: [hook], clock });
    await n.subscribe({ subscriberId: 's', channel: 'webhook', target: 'https://a', topics: ['x'] });
    const e = ev('x');
    await n.handle(e);
    expect((await n.handle(e))[0]!.status).toBe('duplicate');
    expect(hook.calls).toHaveLength(1);
  });

  it('rejects bad subscriptions', async () => {
    const clock = new ManualClock();
    const n = new Notifier({ channels: [new EmailChannel(new ConsoleEmailSender(() => {}))], clock });
    await expect(n.subscribe({ subscriberId: 's', channel: 'sms', target: '+1', topics: ['x'] })).rejects.toThrow(/no channel/);
    await expect(n.subscribe({ subscriberId: 's', channel: 'email', target: 'nope', topics: ['x'] })).rejects.toThrow(/email/);
    await expect(n.subscribe({ subscriberId: 's', channel: 'email', target: 'a@b.co', topics: [] })).rejects.toThrow(/topic/);
    await expect(n.subscribe({ subscriberId: 's', channel: 'email', target: 'a@b.co', topics: ['a..b'] })).rejects.toThrow(/pattern/);
    const id = await n.subscribe({ subscriberId: 's', channel: 'email', target: 'a@b.co', topics: ['x'] });
    expect(await n.unsubscribe(id)).toBe(true);
    expect(await n.handle(ev('x'))).toEqual([]);
  });
});

describe('Notifier retries (fake clock)', () => {
  it('retries one failing subscription with backoff without affecting others, then succeeds', async () => {
    const clock = new ManualClock();
    const flaky = new ScriptedChannel('webhook', clock, [
      { ok: false, retryable: true, error: 'HTTP 503' },
      { ok: false, retryable: true, error: 'HTTP 503' },
    ]);
    const email = new ScriptedChannel('email', clock);
    const outcomes: string[] = [];
    const n = new Notifier({ channels: [flaky, email], clock, onOutcome: (o) => outcomes.push(`${o.channel}:${o.status}:${o.attempt}`) });
    await n.subscribe({ subscriberId: 'a', channel: 'webhook', target: 'https://a', topics: ['x'] });
    await n.subscribe({ subscriberId: 'b', channel: 'email', target: 'b@x.io', topics: ['x'] });
    const first = await n.handle(ev('x'));
    expect(first.map((o) => o.status)).toEqual(['retrying', 'delivered']);
    await clock.runAll();
    expect(flaky.calls.map((c) => [c.attempt, c.at])).toEqual([
      [1, 0],
      [2, 1_000],
      [3, 3_000],
    ]);
    expect(email.calls).toHaveLength(1);
    expect(new Set(flaky.calls.map((c) => c.key)).size).toBe(1); // same idempotency key on every attempt
    expect(outcomes).toEqual(['webhook:retrying:1', 'email:delivered:1', 'webhook:retrying:2', 'webhook:delivered:3']);
    expect(n.failed).toEqual([]);
    // later redelivery of the same event is suppressed for both
    expect((await n.handle(ev('x'))).map((o) => o.status)).toEqual(['duplicate', 'duplicate']);
  });

  it('gives up after maxAttempts, and immediately on permanent failures', async () => {
    const clock = new ManualClock();
    const always = new ScriptedChannel('webhook', clock, Array.from({ length: 10 }, () => ({ ok: false as const, retryable: true, error: 'down' })));
    const perm = new ScriptedChannel('email', clock, [{ ok: false, retryable: false, error: 'bounced' }]);
    const n = new Notifier({ channels: [always, perm], clock });
    await n.subscribe({ subscriberId: 'a', channel: 'webhook', target: 'https://a', topics: ['x'] });
    await n.subscribe({ subscriberId: 'b', channel: 'email', target: 'b@x.io', topics: ['x'] });
    await n.handle(ev('x'));
    await clock.runAll();
    expect(always.calls).toHaveLength(4);
    expect(perm.calls).toHaveLength(1);
    expect(n.failed.map((f) => [f.notification.subscription.subscriberId, f.notification.attempt, f.error])).toEqual([
      ['b', 1, 'bounced'],
      ['a', 4, 'down'],
    ]);
    expect(n.pendingRetries).toBe(0);
    // a failed notification is not recorded as delivered: re-handling tries again
    expect((await n.handle(ev('x'))).map((o) => o.status)).toEqual(['retrying', 'delivered']);
  });

  it('honours Retry-After (capped by the policy max) and treats thrown channel errors as retryable', async () => {
    const clock = new ManualClock();
    const ch = new ScriptedChannel('webhook', clock, [{ ok: false, retryable: true, error: '429', retryAfterMs: 30_000 }]);
    const thrower: NotificationChannel = {
      kind: 'email',
      send: (() => {
        let i = 0;
        return async () => {
          if (i++ === 0) throw new Error('bug');
          return { ok: true };
        };
      })(),
    };
    const n = new Notifier({ channels: [ch, thrower], clock, retry: { email: { maxAttempts: 2, backoff: { initialMs: 10, factor: 1, maxMs: 10 } } } });
    await n.subscribe({ subscriberId: 'a', channel: 'webhook', target: 'https://a', topics: ['x'] });
    await n.subscribe({ subscriberId: 'b', channel: 'email', target: 'b@x.io', topics: ['x'] });
    const r = await n.handle(ev('x'));
    expect(r.map((o) => o.status)).toEqual(['retrying', 'retrying']);
    await clock.advance(29_999);
    expect(ch.calls).toHaveLength(1);
    await clock.advance(1);
    expect(ch.calls.map((c) => c.at)).toEqual([0, 30_000]);
    expect(n.failed).toEqual([]);
  });

  it('end to end: bus → notifier → signed webhook with retries', async () => {
    const clock = new ManualClock(1_790_000_000_000);
    const bodies: Array<{ attempt: string; key: string; sig: string }> = [];
    let status = 502;
    const fetch: FetchLike = async (_url, init) => {
      bodies.push({ attempt: init.headers['Bsh-Delivery-Attempt']!, key: init.headers['Idempotency-Key']!, sig: init.headers['Bsh-Signature']! });
      const s = status;
      status = 200;
      return { status: s, headers: { get: () => null }, text: async () => '' };
    };
    const hook = new WebhookChannel({
      fetch,
      secrets: async () => 'whsec',
      nowSec: () => Math.floor(clock.now() / 1000),
      retry: { maxAttempts: 3, backoff: { initialMs: 5_000, factor: 2, maxMs: 60_000 } },
    });
    const n = new Notifier({ channels: [hook], clock });
    await n.subscribe({ subscriberId: 'acme', channel: 'webhook', target: 'https://hooks.acme.io/bsh', topics: ['collection.*'] });
    const bus = new InMemoryBus({ clock });
    await n.attach(bus);
    const e: EventEnvelope = ev('collection.minted');
    await bus.publish(e);
    await clock.advance(5_000);
    expect(bodies.map((b) => b.attempt)).toEqual(['1', '2']);
    expect(bodies[0]!.key).toBe(bodies[1]!.key);
    expect(bodies[1]!.sig).toMatch(/^t=1790000005,v1=[0-9a-f]{64}$/); // re-signed with a fresh timestamp
  });
});
