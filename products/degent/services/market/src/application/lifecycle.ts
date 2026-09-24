/**
 * Listing transitions: validate against LISTING_TRANSITIONS, persist (optimistic), then publish exactly
 * one `degent.market.listing.{status}` event. Entering a terminal status wipes the seller's signature:
 * a closed listing must not leave a usable 0x83 signature lying around in the database.
 */
import { canTransition, type ListingStatus, type ListingStatusEvent, type Network } from '@bsh/degent-market-sdk';
import { DomainError, StaleWriteError } from '../domain/errors.js';
import { TERMINAL, type ListingRecord } from '../domain/listing.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/event-bus.js';
import type { ListingStore } from '../ports/listing-store.js';
import type { Logger } from './logger.js';

export interface LifecycleDeps {
  store: ListingStore;
  events: EventBus;
  clock: Clock;
  network: Network;
  log: Logger;
}

export function eventFor(r: ListingRecord, previousStatus: ListingStatus | null, network: Network, at: string): ListingStatusEvent {
  return {
    type: `degent.market.listing.${r.status}`,
    eventId: `${r.inscriptionId}:${Date.parse(r.createdAt)}:${r.version}`,
    inscriptionId: r.inscriptionId,
    network,
    status: r.status,
    previousStatus,
    at,
    priceSats: r.priceSats,
    sellerAddress: r.sellerAddress,
    ...(r.statusReason ? { reason: r.statusReason } : {}),
    ...(r.settlementTxid && r.status !== 'active' && r.status !== 'cancelled' && r.status !== 'expired' ? { txid: r.settlementTxid } : {}),
  };
}

export class ListingLifecycle {
  constructor(private readonly d: LifecycleDeps) {}

  private async emit(e: ListingStatusEvent): Promise<void> {
    try {
      await this.d.events.publish(e);
    } catch (err) {
      // The transition is persisted; a lost event is logged (consumers can re-read GET /v1/listings/{id}).
      this.d.log.error('event publish failed', { eventId: e.eventId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async created(r: ListingRecord): Promise<void> {
    await this.emit(eventFor(r, null, this.d.network, r.createdAt));
  }

  /**
   * Persist `r → to` and publish. On a concurrent write (e.g. the watcher touching the row) the record is
   * re-read and the transition retried once if the status is unchanged.
   */
  async transition(r: ListingRecord, to: ListingStatus, reason: string, extra: { txid?: string | null; buyerAddress?: string | null } = {}): Promise<ListingRecord> {
    try {
      return await this.transitionOnce(r, to, reason, extra);
    } catch (e) {
      if (!(e instanceof StaleWriteError)) throw e;
      const fresh = await this.d.store.get(r.inscriptionId);
      if (!fresh || fresh.status !== r.status || fresh.createdAt !== r.createdAt) throw e;
      return this.transitionOnce(fresh, to, reason, extra);
    }
  }

  private async transitionOnce(r: ListingRecord, to: ListingStatus, reason: string, extra: { txid?: string | null; buyerAddress?: string | null }): Promise<ListingRecord> {
    if (!canTransition(r.status, to)) throw new DomainError('listing_not_active', 409, `listing is ${r.status}; cannot become ${to}`);
    const now = this.d.clock.now().toISOString();
    const next: ListingRecord = {
      ...r,
      status: to,
      statusReason: reason,
      settlementTxid: extra.txid === undefined ? r.settlementTxid : extra.txid,
      buyerAddress: extra.buyerAddress === undefined ? r.buyerAddress : extra.buyerAddress,
      updatedAt: now,
      lastCheckedAt: now,
      sellerSignature: TERMINAL.includes(to) ? null : r.sellerSignature,
    };
    const saved = await this.d.store.save(next);
    await this.emit(eventFor(saved, r.status, this.d.network, now));
    return saved;
  }
}
