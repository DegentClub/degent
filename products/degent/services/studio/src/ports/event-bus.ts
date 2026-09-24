import type { ArtworkStatusEvent } from '../domain/events.js';

/**
 * Domain event publisher (contracts/asyncapi/degent-studio.yaml). The in-memory bus is used in
 * dev/tests; `PlatformEventBusAdapter` bridges onto the shared `@bsh/events` bus.
 */
export interface EventBus {
  publish(event: ArtworkStatusEvent): Promise<void>;
}
