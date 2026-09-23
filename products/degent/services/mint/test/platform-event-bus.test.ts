import { describe, expect, it } from 'vitest';
import { InMemoryBus, degentMintOrder, subscribeTopic, type EventEnvelope, type MintOrderStatusChanged } from '@bsh/events';
import type { OrderStatusEvent } from '@bsh/degent-mint-sdk';
import { PlatformEventBusAdapter } from '../src/adapters/platform-event-bus.js';

const sample: OrderStatusEvent = {
  type: 'degent.mint.order.paid',
  eventId: 'ord_1:3',
  orderId: 'ord_1',
  network: 'regtest',
  status: 'paid',
  previousStatus: 'awaiting_payment',
  at: '2026-09-23T12:00:00.000Z',
  lane: 'block',
  txid: 'a'.repeat(64),
};

describe('PlatformEventBusAdapter', () => {
  it('publishes a mint event as a CloudEvents envelope on the platform topic', async () => {
    const bus = new InMemoryBus();
    const received: EventEnvelope<MintOrderStatusChanged>[] = [];
    await subscribeTopic(bus, degentMintOrder, async (env) => {
      received.push(env);
    });

    await new PlatformEventBusAdapter(bus).publish(sample);
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    const env = received[0]!;
    expect(env.specversion).toBe('1.0');
    expect(env.type).toBe('degent.mint.order.paid');
    expect(env.id).toBe('ord_1:3'); // domain eventId -> stable de-duplication key
    expect(env.subject).toBe('ord_1');
    expect(env.source).toBe('urn:bsh:degent-mint');
    expect(env.time).toBe(sample.at);
    expect(env.data).toEqual(sample);
  });

  it('refuses to publish an event that does not match the platform topic schema', async () => {
    const bus = new InMemoryBus();
    const bad = { ...sample, lane: 'express' } as unknown as OrderStatusEvent;
    await expect(new PlatformEventBusAdapter(bus).publish(bad)).rejects.toThrow(/platform topic schema/);
  });
});
