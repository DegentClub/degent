import type { Network, OrderStatusEvent, RoyaltyPaidEvent } from '@bsh/degent-mint-sdk';
import { collectionMinted, createEvent, defineTopic, degentMintOrder, type EventBus as PlatformBus } from '@bsh/events';
import { isCollectionMintedEvent, isRoyaltyPaidEvent, type CollectionMintedEvent, type EventBus, type MintEvent } from '../ports/event-bus.js';

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

/**
 * The degent-owned `degent.mint.royalty.paid` topic (contracts/asyncapi/degent-mint.yaml, RoyaltyPaidEvent),
 * defined here in the platform's topic vocabulary so the bridge validates it like the shared topics. It is a
 * product topic: it is not registered in platform-events.yaml.
 */
export const degentMintRoyaltyPaid = defineTopic<RoyaltyPaidEvent>({
  name: 'degent.mint.royalty.paid',
  version: '1.0.0',
  producer: 'degent-mint',
  description: "The artist royalty output of an artwork order's funding transaction was verified by script and value.",
  dataschema: 'contracts/asyncapi/degent-mint.yaml#/components/schemas/RoyaltyPaidEvent',
  schema: {
    type: 'object',
    required: ['type', 'eventId', 'orderId', 'network', 'artworkId', 'artist', 'sats', 'txid', 'vout', 'at'],
    additionalProperties: false,
    properties: {
      type: { const: 'degent.mint.royalty.paid' },
      eventId: { type: 'string', minLength: 1 },
      orderId: { type: 'string', minLength: 1 },
      network: { type: 'string', enum: NETWORKS },
      artworkId: { type: 'string', minLength: 1 },
      artist: { type: 'string', minLength: 14, maxLength: 100 },
      sats: { type: 'integer', minimum: 0 },
      txid: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      vout: { type: 'integer', minimum: 0 },
      at: { type: 'string', format: 'date-time' },
      edition: { type: 'integer', minimum: 1 },
    },
  },
});

/**
 * Bridges the mint service's domain events onto the shared platform bus (`@bsh/events`).
 *
 * The service emits plain `OrderStatusEvent`s (contracts/asyncapi/degent-mint.yaml), `RoyaltyPaidEvent`s
 * (same contract, degent-owned channel) and `collection.minted` payloads (platform topic 1.1.0). On the
 * platform bus every message is a CloudEvents 1.0 envelope; `degent.mint.order.{status}` and
 * `collection.minted` are what block.space, the notification service and the X bot subscribe to. This
 * adapter is the only place that knows both shapes.
 *
 * - `id` is the domain `eventId` (`<orderId>:<timeline index>`, `<orderId>:royalty`, `<orderId>:minted`),
 *   so redeliveries de-duplicate.
 * - `subject` is the order id, so subscribers can filter one order without parsing `data`.
 * - Every payload is validated against its topic schema before publishing; a schema mismatch is a
 *   programming error and throws, so the contract test suite catches drift instead of production.
 */
export class PlatformEventBusAdapter implements EventBus {
  constructor(
    private readonly bus: PlatformBus,
    private readonly source = 'urn:bsh:degent-mint',
  ) {}

  async publish(event: MintEvent): Promise<void> {
    if (isCollectionMintedEvent(event)) return this.publishMinted(event);
    if (isRoyaltyPaidEvent(event)) return this.publishRoyalty(event);
    return this.publishStatus(event);
  }

  private async publishStatus(event: OrderStatusEvent): Promise<void> {
    const envelope = createEvent({
      source: this.source,
      type: degentMintOrder.typeFor({ status: event.status }),
      subject: event.orderId,
      id: event.eventId,
      time: event.at,
      dataschema: degentMintOrder.dataschema,
      data: event,
    });
    const v = degentMintOrder.validate(envelope.data);
    if (!v.valid) throw new Error(`mint event does not match platform topic schema: ${JSON.stringify(v.errors)}`);
    await this.bus.publish(envelope);
  }

  private async publishRoyalty(event: RoyaltyPaidEvent): Promise<void> {
    const v = degentMintRoyaltyPaid.validate(event);
    if (!v.valid) throw new Error(`royalty.paid event does not match its topic schema: ${JSON.stringify(v.errors)}`);
    await this.bus.publish(degentMintRoyaltyPaid.create({ source: this.source, data: event, subject: event.orderId, id: event.eventId, time: event.at }));
  }

  private async publishMinted(event: CollectionMintedEvent): Promise<void> {
    const { type: _type, ...data } = event;
    const v = collectionMinted.validate(data);
    if (!v.valid) throw new Error(`collection.minted event does not match the platform topic schema: ${JSON.stringify(v.errors)}`);
    await this.bus.publish(
      collectionMinted.create({ source: this.source, data, subject: data.orderId ?? data.inscriptionId, id: `${data.orderId ?? data.inscriptionId}:minted`, time: data.mintedAt }),
    );
  }
}
