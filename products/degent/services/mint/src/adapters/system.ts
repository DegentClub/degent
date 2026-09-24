import type { OrderStatusEvent, RoyaltyPaidEvent } from '@bsh/degent-mint-sdk';
import type { Clock } from '../ports/clock.js';
import { isCollectionMintedEvent, isOrderStatusEvent, isRoyaltyPaidEvent, type CollectionMintedEvent, type EventBus, type MintEvent } from '../ports/event-bus.js';

export const systemClock: Clock = { now: () => new Date() };

/** In-process bus: keeps a bounded history and fans out to subscribers (dev, tests, SSE later). */
export class MemoryEventBus implements EventBus {
  readonly events: MintEvent[] = [];
  private readonly subscribers = new Set<(e: MintEvent) => void>();
  constructor(private readonly maxHistory = 10_000) {}

  /** Typed views over the history. */
  get orderEvents(): OrderStatusEvent[] {
    return this.events.filter(isOrderStatusEvent);
  }
  get royaltyEvents(): RoyaltyPaidEvent[] {
    return this.events.filter(isRoyaltyPaidEvent);
  }
  get mintedEvents(): CollectionMintedEvent[] {
    return this.events.filter(isCollectionMintedEvent);
  }

  async publish(event: MintEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.maxHistory) this.events.splice(0, this.events.length - this.maxHistory);
    for (const s of this.subscribers) {
      try {
        s(event);
      } catch {
        /* a subscriber must never break publishing */
      }
    }
  }

  subscribe(fn: (e: MintEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
