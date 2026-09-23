import type { OrderStatusEvent } from '@bsh/degent-mint-sdk';

/**
 * Domain event publisher (contracts/asyncapi/degent-mint.yaml). The in-memory bus is used in
 * dev/tests; production binds a RabbitMQ adapter (TODO) publishing to the `degent.mint` topic
 * exchange with routing key = event type, persistent delivery, `message_id` = eventId.
 */
export interface EventBus {
  publish(event: OrderStatusEvent): Promise<void>;
}

/** Shape the RabbitMQ adapter will implement (amqplib ConfirmChannel semantics). */
export interface RabbitMqPublisherConfig {
  url: string;
  exchange: string; // 'degent.mint'
  confirmTimeoutMs: number;
}
