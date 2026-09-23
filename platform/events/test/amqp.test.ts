import { describe, expect, it } from 'vitest';
import {
  AmqpBusAdapter,
  ATTEMPT_HEADER,
  blockIndexed,
  CLOUDEVENTS_JSON,
  createEvent,
  ManualClock,
  NonRetryableError,
  platformRegistry,
  subscribeTopic,
  type EventEnvelope,
} from '../src/index.js';
import { FakeAmqpChannel } from './fake-amqp.js';

const block = (network: 'mainnet' | 'signet', height: number) =>
  blockIndexed.create({
    source: 'urn:bsh:bitcoin-indexer',
    params: { network },
    data: { network, height, hash: 'a'.repeat(64), previousHash: 'b'.repeat(64), time: '2026-09-23T12:00:00Z' },
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  });

function setup() {
  const channel = new FakeAmqpChannel();
  const clock = new ManualClock();
  const errors: Array<{ attempt: number; deadLettered: boolean }> = [];
  const bus = new AmqpBusAdapter({
    channel,
    service: 'svc',
    registry: platformRegistry(),
    clock,
    defaultBackoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
    defaultMaxAttempts: 3,
    onError: (i) => errors.push({ attempt: i.attempt, deadLettered: i.deadLettered }),
  });
  return { channel, clock, bus, errors };
}

describe('AmqpBusAdapter against a fake channel', () => {
  it('declares topology and publishes structured CloudEvents with AMQP properties', async () => {
    const { channel, bus } = setup();
    const e = block('mainnet', 1);
    await bus.publish(e);
    expect(channel.exchanges).toEqual(new Map([['bsh.events', 'topic'], ['bsh.events.dlx', 'direct']]));
    expect(channel.prefetchCount).toBe(16);
    const p = channel.published[0]!;
    expect(p.exchange).toBe('bsh.events');
    expect(p.routingKey).toBe('block.indexed.mainnet');
    expect(p.options).toMatchObject({
      persistent: true,
      messageId: e.id,
      contentType: CLOUDEVENTS_JSON,
      type: 'block.indexed.mainnet',
      appId: 'urn:bsh:bitcoin-indexer',
      timestamp: Math.floor(Date.parse(e.time) / 1000),
      headers: { traceparent: e.traceparent },
    });
    expect(JSON.parse(p.body)).toEqual(e);
    expect(channel.confirms).toBe(1);
  });

  it('refuses invalid events before touching the broker', async () => {
    const { channel, bus } = setup();
    await expect(bus.publish(createEvent({ source: 's', type: 'block.indexed.mainnet', data: {} }))).rejects.toThrow(/missing required/);
    expect(channel.published).toEqual([]);
  });

  it('binds per-subscriber queues with wildcards and a DLQ, acks on success', async () => {
    const { channel, bus } = setup();
    const got: string[] = [];
    const sub = await subscribeTopic(bus, blockIndexed, (e) => void got.push(`${e.data.network}:${e.data.height}`));
    expect(sub.name).toBe('svc.block.indexed.any');
    expect(channel.queues.get(sub.name)!.args).toEqual({ 'x-dead-letter-exchange': 'bsh.events.dlx', 'x-dead-letter-routing-key': sub.name });
    expect(channel.bindings).toEqual([
      { queue: sub.name, exchange: 'bsh.events', pattern: 'block.indexed.*' },
      { queue: `${sub.name}.dlq`, exchange: 'bsh.events.dlx', pattern: sub.name },
    ]);
    const mainnetOnly: string[] = [];
    await bus.subscribe('#.mainnet', (e) => void mainnetOnly.push(e.type), { name: 'svc.mainnet' });

    await bus.publish(block('mainnet', 1));
    await bus.publish(block('signet', 2));
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual(['mainnet:1', 'signet:2']);
    expect(mainnetOnly).toEqual(['block.indexed.mainnet']);
    expect(channel.acked).toHaveLength(3);
    expect(channel.nacked).toEqual([]);

    await sub.unsubscribe();
    await bus.publish(block('mainnet', 3));
    await new Promise((r) => setImmediate(r));
    expect(got).toHaveLength(2);
    expect(channel.depth(sub.name)).toHaveLength(1); // durable queue keeps it for the next consumer
  });

  it('retries via republish with an attempt header and backoff, then dead-letters to the DLQ', async () => {
    const { channel, clock, bus, errors } = setup();
    const attempts: Array<[number, number]> = [];
    await bus.subscribe('block.indexed.{network}', (_e, ctx) => {
      attempts.push([ctx.attempt, clock.now()]);
      throw new Error('db down');
    }, { name: 'q' });
    await bus.publish(block('mainnet', 7));
    await clock.runAll();
    expect(attempts).toEqual([
      [1, 0],
      [2, 100],
      [3, 300],
    ]);
    const retries = channel.published.filter((p) => p.exchange === '');
    expect(retries.map((p) => [p.routingKey, p.options.headers?.[ATTEMPT_HEADER]])).toEqual([
      ['q', 2],
      ['q', 3],
    ]);
    expect(retries[0]!.options.messageId).toBe(channel.published[0]!.options.messageId);
    expect(channel.acked).toHaveLength(2); // originals acked only after their retry copy was republished
    expect(channel.nacked.map((n) => n.requeue)).toEqual([false]);
    const dlq = channel.depth('q.dlq');
    expect(dlq).toHaveLength(1);
    expect((JSON.parse(Buffer.from(dlq[0]!.content).toString()) as EventEnvelope).type).toBe('block.indexed.mainnet');
    expect(errors).toEqual([
      { attempt: 1, deadLettered: false },
      { attempt: 2, deadLettered: false },
      { attempt: 3, deadLettered: true },
    ]);
  });

  it('dead-letters poison messages and NonRetryableError immediately', async () => {
    const { channel, bus } = setup();
    let calls = 0;
    await bus.subscribe('#', () => {
      calls++;
      throw new NonRetryableError('bad business data');
    }, { name: 'q' });
    channel.publish('bsh.events', 'block.indexed.mainnet', Buffer.from('not json'), {});
    channel.publish('bsh.events', 'block.indexed.mainnet', Buffer.from(JSON.stringify(createEvent({ source: 's', type: 'block.indexed.mainnet', data: {} }))), {});
    await bus.publish(block('mainnet', 1));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1); // only the valid message reaches the handler
    expect(channel.nacked.every((n) => !n.requeue)).toBe(true);
    expect(channel.depth('q.dlq')).toHaveLength(3);
  });

  it('close() cancels pending retries (message stays unacked for broker redelivery)', async () => {
    const { channel, clock, bus } = setup();
    await bus.subscribe('#', () => {
      throw new Error('x');
    }, { name: 'q' });
    await bus.publish(block('mainnet', 1));
    await bus.close();
    await clock.advance(1e6);
    expect(channel.acked).toEqual([]);
    expect(channel.published.filter((p) => p.exchange === '')).toEqual([]);
  });
});
