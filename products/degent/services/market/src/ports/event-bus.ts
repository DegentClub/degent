import type { ListingStatusEvent } from '@bsh/degent-market-sdk';

/** `degent.market.listing.{status}` publisher (contracts/asyncapi/degent-market.yaml). */
export interface EventBus {
  publish(event: ListingStatusEvent): Promise<void>;
}
