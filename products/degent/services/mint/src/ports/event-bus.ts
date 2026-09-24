import type { OrderStatusEvent, RoyaltyPaidEvent } from '@bsh/degent-mint-sdk';
import type { CollectionMinted } from '@bsh/events';

/**
 * `collection.minted` as the mint emits it: the platform topic's payload (1.1.0, with the Open Studio
 * fields) plus a `type` discriminator for the in-process bus. The platform adapter strips `type`.
 */
export interface CollectionMintedEvent extends CollectionMinted {
  type: 'collection.minted';
}

/** Every event the mint publishes: order transitions, royalty payments (degent-owned) and collection.minted (platform-owned). */
export type MintEvent = OrderStatusEvent | RoyaltyPaidEvent | CollectionMintedEvent;

export const isOrderStatusEvent = (e: MintEvent): e is OrderStatusEvent => e.type.startsWith('degent.mint.order.');
export const isRoyaltyPaidEvent = (e: MintEvent): e is RoyaltyPaidEvent => e.type === 'degent.mint.royalty.paid';
export const isCollectionMintedEvent = (e: MintEvent): e is CollectionMintedEvent => e.type === 'collection.minted';

/**
 * Domain event publisher (contracts/asyncapi/degent-mint.yaml + the platform's collection.minted). The
 * in-memory bus is used in dev/tests; production bridges onto `@bsh/events` (PlatformEventBusAdapter),
 * which RabbitMQ binds through `connectAmqpBus` (Phase 5).
 */
export interface EventBus {
  publish(event: MintEvent): Promise<void>;
}

/** Shape the RabbitMQ adapter will implement (amqplib ConfirmChannel semantics). */
export interface RabbitMqPublisherConfig {
  url: string;
  exchange: string; // 'degent.mint'
  confirmTimeoutMs: number;
}
