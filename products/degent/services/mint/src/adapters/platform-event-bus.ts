import type { Network, OrderStatusEvent, RoyaltyPaidEvent } from '@bsh/degent-mint-sdk';
import {
  collectionMinted,
  createEvent,
  defineTopic,
  degentMintOrder,
  platformRegistry,
  TopicError,
  type EventBus as PlatformBus,
  type TopicRegistry,
} from '@bsh/events';
import type { Logger } from '../application/logger.js';
import { silentLogger } from '../application/logger.js';
import { isCollectionMintedEvent, isRoyaltyPaidEvent, type CollectionMintedEvent, type EventBus, type MintEvent } from '../ports/event-bus.js';

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];

/**
 * The degent-owned `degent.mint.royalty.paid` topic (contracts/asyncapi/degent-mint.yaml, RoyaltyPaidEvent),
 * defined here in the platform's topic vocabulary so the bridge validates it like the shared topics. It is a
 * product topic: it is not registered in platform-events.yaml.
 */
export const degentMintRoyaltyPaid = defineTopic<RoyaltyPaidEvent>({
  name: 'degent.mint.royalty.paid',
  version: '1.0.0',
  producer: 'degent-mint',
  description: "The artist royalty output of an artwork order's funding transaction was verified by script and value.",
  dataschema: 'contracts/asyncapi/degent-mint.yaml#/components/schemas/RoyaltyPaidEvent',
  schema: {
    type: 'object',
    required: ['type', 'eventId', 'orderId', 'network', 'artworkId', 'artist', 'sats', 'txid', 'vout', 'at'],
    additionalProperties: false,
    properties: {
      type: { const: 'degent.mint.royalty.paid' },
      eventId: { type: 'string', minLength: 1 },
      orderId: { type: 'string', minLength: 1 },
      network: { type: 'string', enum: NETWORKS },
      artworkId: { type: 'string', minLength: 1 },
      artist: { type: 'string', minLength: 14, maxLength: 100 },
      sats: { type: 'integer', minimum: 0 },
      txid: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      vout: { type: 'integer', minimum: 0 },
      at: { type: 'string', format: 'date-time' },
      edition: { type: 'integer', minimum: 1 },
    },
  },
});

/**
 * Bridges the mint service's domain events onto the shared platform bus (`@bsh/events`).
 *
 * The service emits plain `OrderStatusEvent`s (contracts/asyncapi/degent-mint.yaml), `RoyaltyPaidEvent`s
 * (same contract, degent-owned channel) and `collection.minted` payloads (platform topic 1.1.0). On the
 * platform bus every message is a CloudEvents 1.0 envelope; `degent.mint.order.{status}` and
 * `collection.minted` are what block.space, the notification service and the X bot subscribe to. This
 * adapter is the only place that knows both shapes.
 *
 * - `id` is the domain `eventId` (`<orderId>:<timeline index>`, `<orderId>:royalty`, `<orderId>:minted`),
 *   so redeliveries de-duplicate.
 * - `subject` is the order id, so subscribers can filter one order without parsing `data`.
 * - Every payload is validated against its topic schema before publishing; a schema mismatch is a
 *   programming error and throws, so the contract test suite catches drift instead of production.
 */
export class PlatformEventBusAdapter implements EventBus {
  constructor(
    private readonly bus: PlatformBus,
    private readonly source = 'urn:bsh:degent-mint',
  ) {}

  async publish(event: MintEvent): Promise<void> {
    if (isCollectionMintedEvent(event)) return this.publishMinted(event);
    if (isRoyaltyPaidEvent(event)) return this.publishRoyalty(event);
    return this.publishStatus(event);
  }

  private async publishStatus(event: OrderStatusEvent): Promise<void> {
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

  private async publishRoyalty(event: RoyaltyPaidEvent): Promise<void> {
    const v = degentMintRoyaltyPaid.validate(event);
    if (!v.valid) throw new Error(`royalty.paid event does not match its topic schema: ${JSON.stringify(v.errors)}`);
    await this.bus.publish(degentMintRoyaltyPaid.create({ source: this.source, data: event, subject: event.orderId, id: event.eventId, time: event.at }));
  }

  private async publishMinted(event: CollectionMintedEvent): Promise<void> {
    const { type: _type, ...data } = event;
    const v = collectionMinted.validate(data);
    if (!v.valid) throw new Error(`collection.minted event does not match the platform topic schema: ${JSON.stringify(v.errors)}`);
    await this.bus.publish(
      collectionMinted.create({ source: this.source, data, subject: data.orderId ?? data.inscriptionId, id: `${data.orderId ?? data.inscriptionId}:minted`, time: data.mintedAt }),
    );
  }
}

/**
 * The registry the AMQP bus validates against: the platform topics plus the degent-owned royalty topic
 * (the platform registry alone would reject `degent.mint.royalty.paid` as an unknown topic).
 */
export function mintEventRegistry(): TopicRegistry {
  const r = platformRegistry();
  r.register(degentMintRoyaltyPaid);
  return r;
}

export interface BusStatus {
  /** `memory`: events stay in this process (regtest, or AMQP_URL unset off mainnet). `amqp`: bridged to RabbitMQ. */
  mode: 'memory' | 'amqp';
  exchange: string | null;
  connected: boolean;
  /** Events accepted locally but not yet confirmed by the broker (retried on the next publish / flush). */
  pending: number;
  published: number;
  dropped: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface BridgedEventBusOptions {
  log?: Logger;
  exchange?: string;
  /** A broker that never confirms must not stall an order transition. Default 5 s. */
  publishTimeoutMs?: number;
  /** Backlog bound; beyond it the OLDEST pending event is dropped (and logged). Default 10,000. */
  maxPending?: number;
  /** After a failed publish, new events only queue (no broker round-trip) for this long. Default 15 s. */
  retryAfterMs?: number;
  now?: () => Date;
}

/**
 * The mint's `EventBus`: every event goes to the in-process bus (history, local subscribers) and, when a
 * platform bus is attached (RabbitMQ via `connectAmqpBus`), through `PlatformEventBusAdapter` onto the shared
 * exchange.
 *
 * A broker problem never breaks an order transition (the state is already saved when the event is emitted):
 * a failed or unconfirmed publish is kept in a bounded, ordered backlog, logged as `event.publish.failed`,
 * reported by `GET /v1/health` (`bus` check) and retried before the next event. Redelivery is safe: the
 * envelope id is the domain `eventId`, and platform consumers de-duplicate on it. An event that can never be
 * published (schema mismatch: a programming error, caught by the contract tests) is dropped and logged
 * instead of blocking the backlog. The backlog is in memory: events still pending at shutdown are logged by id
 * (`event.publish.lost`) so an operator can replay them from the order timeline.
 */
export class BridgedEventBus implements EventBus {
  private readonly adapter: PlatformEventBusAdapter | null;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly now: () => Date;
  private readonly pending: MintEvent[] = [];
  private flushing: Promise<void> | null = null;
  private connected: boolean;
  private published = 0;
  private dropped = 0;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private nextAttemptAt = 0;

  constructor(
    private readonly local: EventBus,
    platform: PlatformBus | null,
    private readonly o: BridgedEventBusOptions = {},
  ) {
    this.adapter = platform ? new PlatformEventBusAdapter(platform) : null;
    this.connected = platform !== null;
    this.log = o.log ?? silentLogger;
    this.timeoutMs = o.publishTimeoutMs ?? 5_000;
    this.maxPending = o.maxPending ?? 10_000;
    this.now = o.now ?? (() => new Date());
  }

  async publish(event: MintEvent): Promise<void> {
    await this.local.publish(event);
    if (!this.adapter) return;
    this.pending.push(event);
    while (this.pending.length > this.maxPending) {
      const lost = this.pending.shift()!;
      this.dropped++;
      this.log.error('event.publish.lost', { event: 'event.publish.lost', eventId: eventIdOf(lost), type: lost.type, reason: 'backlog full' });
    }
    // While the broker is failing, queue without waiting on it: a transition must never stall on the bus.
    if (this.now().getTime() < this.nextAttemptAt) return;
    await this.flush();
  }

  /** Publish the backlog in order; stops at the first failure (kept for the next attempt). */
  async flush(): Promise<void> {
    if (!this.adapter) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.pending.length > 0) {
          const next = this.pending[0]!;
          try {
            await withTimeout(this.adapter!.publish(next), this.timeoutMs, `broker did not confirm within ${this.timeoutMs} ms`);
            this.pending.shift();
            this.published++;
            this.nextAttemptAt = 0;
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            if (e instanceof TopicError || /schema/.test(error)) {
              this.pending.shift();
              this.dropped++;
              this.log.error('event.publish.lost', { event: 'event.publish.lost', eventId: eventIdOf(next), type: next.type, reason: error });
              continue;
            }
            this.lastError = error;
            this.lastErrorAt = this.now().toISOString();
            this.nextAttemptAt = this.now().getTime() + (this.o.retryAfterMs ?? 15_000);
            this.log.error('event.publish.failed', { event: 'event.publish.failed', eventId: eventIdOf(next), type: next.type, pending: this.pending.length, error });
            return;
          }
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  /** The broker or channel closed under us (connectAmqpBus `onClose`). */
  markDisconnected(reason: string): void {
    this.connected = false;
    this.lastError = reason;
    this.lastErrorAt = this.now().toISOString();
  }

  /** Last flush attempt, then log whatever could not be delivered. */
  async drain(): Promise<void> {
    if (this.connected) await this.flush().catch(() => undefined);
    for (const e of this.pending.splice(0)) {
      this.dropped++;
      this.log.error('event.publish.lost', { event: 'event.publish.lost', eventId: eventIdOf(e), type: e.type, reason: 'shutdown with the event unpublished' });
    }
  }

  status(): BusStatus {
    return {
      mode: this.adapter ? 'amqp' : 'memory',
      exchange: this.adapter ? (this.o.exchange ?? 'bsh.events') : null,
      connected: this.connected,
      pending: this.pending.length,
      published: this.published,
      dropped: this.dropped,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  /** `GET /v1/health` check. */
  health(): { ok: boolean; detail: string } {
    const s = this.status();
    if (s.mode === 'memory') return { ok: true, detail: 'in-process only (AMQP_URL unset): events do not leave this process' };
    if (!s.connected) return { ok: false, detail: `amqp ${s.exchange} disconnected: ${s.lastError ?? 'closed'}` };
    if (s.pending > 0) return { ok: false, detail: `amqp ${s.exchange}: ${s.pending} event(s) pending, last error: ${s.lastError ?? 'none'}` };
    return { ok: true, detail: `amqp ${s.exchange} connected` };
  }
}

function eventIdOf(e: MintEvent): string {
  return isCollectionMintedEvent(e) ? `${e.orderId ?? e.inscriptionId}:minted` : e.eventId;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}
