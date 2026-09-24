import type { NotifyChannel } from '@bsh/degent-mint-sdk';

/** A minter's request to hear about one order (POST /v1/orders/{id}/subscriptions). The address is PII. */
export interface OrderSubscriptionRecord {
  /** `sub_` + 24 hex: sha256(orderId, channel, address), so re-subscribing is idempotent. */
  id: string;
  orderId: string;
  channel: NotifyChannel;
  address: string;
  createdAt: string;
}

/** Per-order notification subscriptions. Memory (dev/tests) and SQLite (sharing the order database). */
export interface OrderSubscriptionStore {
  /** Insert, or return the existing record with the same id. */
  add(sub: OrderSubscriptionRecord): Promise<OrderSubscriptionRecord>;
  listByOrder(orderId: string): Promise<OrderSubscriptionRecord[]>;
}
