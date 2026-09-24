/**
 * Bridges the studio's domain events onto the shared platform bus (`@bsh/events`).
 *
 * The service emits plain `ArtworkStatusEvent`s (contracts/asyncapi/degent-studio.yaml). On the
 * platform bus every message is a CloudEvents 1.0 envelope on the `degent.artwork.{status}` topic.
 * The topic is defined HERE (it is product-owned, not a platform topic) with `defineTopic`, which
 * validates every payload against the schema before publishing, so drift from the contract is a
 * thrown error in tests, not a bad message in production.
 *
 * - `id` is the domain `eventId` (`<artworkId>:<timeline index>`), so redeliveries de-duplicate.
 * - `subject` is the artwork id, so subscribers can filter one artwork without parsing `data`.
 */
import { defineTopic, type EventBus as PlatformBus, type JsonSchema } from '@bsh/events';
import { ARTWORK_STATUSES } from '../domain/artwork.js';
import type { ArtworkStatusEvent } from '../domain/events.js';
import type { EventBus } from '../ports/event-bus.js';

export const STUDIO_SOURCE = 'urn:bsh:degent-studio';
export const CONTRACT_PATH = 'contracts/asyncapi/degent-studio.yaml';

/** Mirrors `ArtworkStatusEvent` in the AsyncAPI contract (asserted equal in test/events.test.ts). */
export const ARTWORK_STATUS_EVENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'eventId', 'artworkId', 'artist', 'status', 'previousStatus', 'at'],
  properties: {
    type: { type: 'string', pattern: '^degent\\.artwork\\.[a-z_]+$' },
    eventId: { type: 'string' },
    artworkId: { type: 'string' },
    artist: { type: 'string' },
    network: { type: 'string', enum: ['mainnet', 'testnet', 'signet', 'regtest'] },
    status: { type: 'string', enum: [...ARTWORK_STATUSES] },
    previousStatus: { oneOf: [{ type: 'string', enum: [...ARTWORK_STATUSES] }, { type: 'null' }] },
    at: { type: 'string', format: 'date-time' },
    contentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    detail: { type: 'string' },
  },
};

export const degentArtwork = defineTopic<ArtworkStatusEvent>({
  name: 'degent.artwork.{status}',
  version: '1.0.0',
  producer: 'degent-studio',
  description: 'An artwork in the degent.club studio entered a new status (submitted, reviewing, approved, rejected, delisted).',
  params: { status: { description: 'The status the artwork just entered.', enum: ARTWORK_STATUSES } },
  dataschema: `https://blockspace.holdings/${CONTRACT_PATH}#/components/schemas/ArtworkStatusEvent`,
  schema: ARTWORK_STATUS_EVENT_SCHEMA,
});

export class PlatformEventBusAdapter implements EventBus {
  constructor(
    private readonly bus: PlatformBus,
    private readonly source = STUDIO_SOURCE,
  ) {}

  async publish(event: ArtworkStatusEvent): Promise<void> {
    const envelope = degentArtwork.create({
      source: this.source,
      data: event,
      params: { status: event.status },
      subject: event.artworkId,
      id: event.eventId,
      time: event.at,
    });
    await this.bus.publish(envelope);
  }
}
