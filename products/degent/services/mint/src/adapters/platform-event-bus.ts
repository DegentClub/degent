import type { OrderStatusEvent } from '@bsh/degent-mint-sdk';
import { createEvent, degentMintOrder, type EventBus as PlatformBus } from '@bsh/events';
import type { EventBus } from '../ports/event-bus.js';

/**
 * Bridges the mint service's domain events onto the shared platform bus (`@bsh/events`).
 *
 * The service emits plain `OrderStatusEvent`s (contracts/asyncapi/degent-mint.yaml). On the
 * platform bus every message is a CloudEvents 1.0 envelope on the `degent.mint.order.{status}`
 * topic (contracts/asyncapi/platform-events.yaml), which is what block.space, the notification
 * service and the X bot subscribe to. This adapter is the only place that knows both shapes.
 *
 * - `id` is the domain `eventId` (`<orderId>:<timeline index>`), so redeliveries de-duplicate.
 * - `subject` is the order id, so subscribers can filter one order without parsing `data`.
 * - The payload is validated against the topic schema before publishing; a schema mismatch is a
 *   programming error and throws, so the contract test suite catches drift instead of production.
 */
export class PlatformEventBusAdapter implements EventBus {
  constructor(
    private readonly bus: PlatformBus,
    private readonly source = 'urn:bsh:degent-mint',
  ) {}

  async publish(event: OrderStatusEvent): Promise<void> {
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
}
