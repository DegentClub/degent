import type { ListingStatusEvent } from '@bsh/degent-market-sdk';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/event-bus.js';

export const systemClock: Clock = { now: () => new Date() };

/** In-process bus: bounded history plus fan-out (dev, tests). Production: RabbitMQ exchange `degent.market`. */
export class MemoryEventBus implements EventBus {
  readonly events: ListingStatusEvent[] = [];
  private readonly subscribers = new Set<(e: ListingStatusEvent) => void>();
  constructor(private readonly maxHistory = 10_000) {}

  async publish(event: ListingStatusEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.maxHistory) this.events.splice(0, this.events.length - this.maxHistory);
    for (const s of this.subscribers) {
      try {
        s(event);
      } catch {
        /* a subscriber never breaks publishing */
      }
    }
  }

  subscribe(fn: (e: ListingStatusEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
