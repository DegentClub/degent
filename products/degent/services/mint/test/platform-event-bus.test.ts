import { describe, expect, it } from 'vitest';
import { InMemoryBus, collectionMinted, degentMintOrder, platformRegistry, subscribeTopic, type CollectionMinted, type EventEnvelope, type MintOrderStatusChanged } from '@bsh/events';
import type { OrderStatusEvent, RoyaltyPaidEvent } from '@bsh/degent-mint-sdk';
import { PlatformEventBusAdapter, degentMintRoyaltyPaid } from '../src/adapters/platform-event-bus.js';
import type { CollectionMintedEvent } from '../src/ports/event-bus.js';

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

const royalty: RoyaltyPaidEvent = {
  type: 'degent.mint.royalty.paid',
  eventId: 'ord_1:royalty',
  orderId: 'ord_1',
  network: 'regtest',
  artworkId: 'art_1',
  artist: 'bcrt1pexampleartistpayoutaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  sats: 330,
  txid: 'b'.repeat(64),
  vout: 1,
  at: '2026-09-23T12:00:00.000Z',
  edition: 1,
};

const minted: CollectionMintedEvent = {
  type: 'collection.minted',
  collectionId: 'degent',
  network: 'regtest',
  inscriptionId: `${'c'.repeat(64)}i0`,
  parentInscriptionId: `${'d'.repeat(64)}i0`,
  txid: 'c'.repeat(64),
  orderId: 'ord_1',
  contentHash: 'e'.repeat(64),
  mintedAt: '2026-09-23T12:10:00.000Z',
  artist: 'bcrt1pexampleartistpayoutaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  artworkId: 'art_1',
  edition: 1,
  royalty: { txid: 'b'.repeat(64), vout: 1, sats: 330 },
};

describe('PlatformEventBusAdapter: Open Studio events', () => {
  it('publishes degent.mint.royalty.paid on the product topic (id = <orderId>:royalty, subject = order)', async () => {
    const bus = new InMemoryBus();
    const received: EventEnvelope<RoyaltyPaidEvent>[] = [];
    await subscribeTopic(bus, degentMintRoyaltyPaid, async (env) => {
      received.push(env);
    });
    await new PlatformEventBusAdapter(bus).publish(royalty);
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'degent.mint.royalty.paid', id: 'ord_1:royalty', subject: 'ord_1', source: 'urn:bsh:degent-mint', time: royalty.at, data: royalty });
    expect(degentMintRoyaltyPaid.validate({ ...royalty, sats: -1 }).valid).toBe(false);
    await expect(new PlatformEventBusAdapter(bus).publish({ ...royalty, vout: -1 })).rejects.toThrow(/royalty.paid event/);
  });

  it('publishes collection.minted on the platform topic (1.1.0, registry-validated) with the Open Studio fields and without the type discriminator', async () => {
    const bus = new InMemoryBus({ registry: platformRegistry() });
    const received: EventEnvelope<CollectionMinted>[] = [];
    await subscribeTopic(bus, collectionMinted, async (env) => {
      received.push(env);
    });
    await new PlatformEventBusAdapter(bus).publish(minted);
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
    const { type: _t, ...data } = minted;
    expect(received[0]).toMatchObject({ type: 'collection.minted', id: 'ord_1:minted', subject: 'ord_1', time: minted.mintedAt, data });
    expect(received[0]!.data).not.toHaveProperty('type');
    expect(collectionMinted.version).toBe('1.1.0');
    await expect(new PlatformEventBusAdapter(bus).publish({ ...minted, edition: 0 })).rejects.toThrow(/collection.minted/);
  });
});
