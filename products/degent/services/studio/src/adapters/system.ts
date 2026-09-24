import type { ArtworkStatusEvent } from '../domain/events.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/event-bus.js';

export const systemClock: Clock = { now: () => new Date() };

/** In-process bus: keeps a bounded history and fans out to subscribers (dev, tests, SSE later). */
export class MemoryEventBus implements EventBus {
  readonly events: ArtworkStatusEvent[] = [];
  private readonly subscribers = new Set<(e: ArtworkStatusEvent) => void>();
  constructor(private readonly maxHistory = 10_000) {}

  async publish(event: ArtworkStatusEvent): Promise<void> {
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

  subscribe(fn: (e: ArtworkStatusEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
