/**
 * Application service: every order mutation (API or worker) goes through here so that each
 * transition is validated by the state machine, persisted with a timestamp and emitted as an event.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { addressToScript, estimateResignedRescueWeight, verifyHalfSignedReveal, vsizeFromWeight, type InscriptionContent } from '@bsh/inscription';
import type {
  BlockLaneItem,
  BlockSlot,
  CreateOrderRequest,
  CreateOrderResponse,
  Lane,
  Order,
  OrderEvent,
  OrderStatus,
  PayoutScriptType,
  QueueInfo,
  QueueResponse,
  RescueInputs,
  ReviewResult,
  RoyaltyPaidEvent,
  SubmitRevealRequest,
  Tier,
} from '@bsh/degent-mint-sdk';
import {
  BLOCK_INTERVAL_MINUTES,
  BLOCK_LANE_WEIGHT_BUDGET,
  blockSlotOf,
  isSha256Hex,
  isTier,
  packBlockSlots,
  sha256Hex,
  tierRule,
  validateContentMeta,
} from '@bsh/degent-mint-sdk';
import { addressKind, checkRecipientAddress } from '../domain/address.js';
import { DomainError, conflict, invalid, notFound } from '../domain/errors.js';
import { hasConfirmedReveal, IN_FLIGHT, WAITING_FOR_LANE, isArtworkOrder, toPublicOrder, type LedgerRecordState, type OrderRecord, type RoyaltyReportState } from '../domain/order.js';
import { attributionFor, computeQuote, inscriptionContent, type ArtworkQuoteInput } from '../domain/quote.js';
import { retryDelayMs } from '../domain/royalty.js';
import { transition as checkTransition } from '../domain/state-machine.js';
import type { ArtReview } from '../ports/art-review.js';
import type { ChainPort, ChainTx } from '../ports/chain.js';
import type { Clock } from '../ports/clock.js';
import type { ContentStore } from '../ports/content-store.js';
import { EditionsSoldOutError, type EditionStore } from '../ports/edition-store.js';
import type { CollectionMintedEvent, EventBus } from '../ports/event-bus.js';
import type { FeePort } from '../ports/fees.js';
import { LedgerClientError, type LedgerClient } from '../ports/ledger-client.js';
import type { OrderStore } from '../ports/order-store.js';
import type { RevealVault } from '../ports/reveal-vault.js';
import { StudioClientError, type StudioArtwork, type StudioClient } from '../ports/studio-client.js';
import { buildLedgerLineItems, ledgerIdempotencyKeys } from './ledger-recording.js';
import { silentLogger, type Logger } from './logger.js';
import { COLLECTION_ID, type MintSettings } from './settings.js';

export interface OrderServiceDeps {
  settings: MintSettings;
  store: OrderStore;
  content: ContentStore;
  reveals: RevealVault;
  review: ArtReview;
  events: EventBus;
  clock: Clock;
  /** Edition reservations for Open Studio artwork orders (plan §3.4). */
  editions: EditionStore;
  chain?: ChainPort;
  /** Used only for the rescue's `suggestedFeeRate`; falls back to the collection minimum. */
  fees?: FeePort;
  /** The Artist Studio; without it artwork orders are refused (plan §3). */
  studio?: StudioClient;
  /** The platform ledger; optional, never blocks a mint (plan §3.5). */
  ledger?: LedgerClient;
  log?: Logger;
  newId?: () => string;
  newToken?: () => string;
}

const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest();

const ARTWORK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The payout script types the studio accepts (ADR-0007 §3) and the dust table knows. */
function payoutScriptTypeOf(kind: ReturnType<typeof addressKind>): PayoutScriptType | null {
  return kind === 'tr' ? 'p2tr' : kind === 'wpkh' ? 'p2wpkh' : null;
}

/** 409 `artwork_not_mintable` for an artwork whose edition cap is reached (ADR-0012). */
function soldOut(artworkId: string, maxEditions: number, held: number): DomainError {
  return new DomainError('artwork_not_mintable', 409, `artwork ${artworkId} is sold out (${maxEditions} editions)`, {
    status: 'approved',
    soldOut: true,
    maxEditions,
    held,
  });
}

const INITIAL_ROYALTY_REPORT: RoyaltyReportState = { emittedAt: null, reportedAt: null, attempts: 0, nextAttemptAt: null, lastError: null, gaveUp: false };
const INITIAL_LEDGER: LedgerRecordState = { orderId: null, paymentId: null, attempts: 0, nextAttemptAt: null, lastError: null, observedAt: null, observedConfirmed: false };

export class OrderService {
  private readonly log: Logger;

  constructor(private readonly d: OrderServiceDeps) {
    this.log = d.log ?? silentLogger;
  }

  get settings(): MintSettings {
    return this.d.settings;
  }

  /** Whether artwork orders can be taken (a studio is wired). */
  get studioEnabled(): boolean {
    return this.d.studio !== undefined;
  }

  private now(): Date {
    return this.d.clock.now();
  }

  private newId(): string {
    return this.d.newId?.() ?? `dgt_${randomBytes(12).toString('hex')}`;
  }

  // ---------------------------------------------------------------- auth

  /**
   * Bearer-token check for the order's mutating/sensitive endpoints. Constant-time comparison of
   * SHA-256 digests. 401 when no token was presented, 403 when it does not match.
   */
  async authorize(orderId: string, authorization: string | undefined | null): Promise<OrderRecord> {
    const r = await this.d.store.get(orderId);
    if (!r) throw notFound('order');
    const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})\s*$/.exec(authorization ?? '');
    if (!m) throw new DomainError('unauthorized', 401, 'missing or malformed order token (Authorization: Bearer <orderToken>)');
    const presented = hashToken(m[1]!);
    const stored = Buffer.from(r.orderTokenHash, 'hex');
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented))
      throw new DomainError('forbidden', 403, 'order token does not match this order');
    return r;
  }

  // ---------------------------------------------------------------- transitions

  /** Validated, persisted, emitted transition. Returns the saved record. */
  async transition(
    r: OrderRecord,
    to: OrderStatus,
    opts: { detail?: string; txid?: string; patch?: Partial<OrderRecord> } = {},
  ): Promise<OrderRecord> {
    checkTransition(r.status, to);
    const at = this.now().toISOString();
    const ev: OrderEvent = { status: to, at };
    if (opts.detail) ev.detail = opts.detail;
    if (opts.txid) ev.txid = opts.txid;
    const next: OrderRecord = { ...r, ...opts.patch, status: to, updatedAt: at, timeline: [...r.timeline, ev] };
    const saved = await this.d.store.save(next);
    await this.d.events.publish({
      type: `degent.mint.order.${to}`,
      eventId: `${saved.id}:${saved.timeline.length}`,
      orderId: saved.id,
      network: saved.network,
      status: to,
      previousStatus: r.status,
      at,
      lane: saved.lane,
      ...(opts.detail ? { detail: opts.detail } : {}),
      ...(opts.txid ? { txid: opts.txid } : {}),
      ...(saved.inscriptionId ? { inscriptionId: saved.inscriptionId } : {}),
      // Artwork facts are deliberately NOT on the shared degent.mint.order.{status} payload (platform-owned
      // topic; extending it is a platform PR first): they travel on royalty.paid, collection.minted and the API.
    });
    return saved;
  }

  /** Persist non-status changes (bookkeeping) without an event. */
  async patch(r: OrderRecord, patch: Partial<OrderRecord>): Promise<OrderRecord> {
    return this.d.store.save({ ...r, ...patch, updatedAt: this.now().toISOString() });
  }

  // ---------------------------------------------------------------- queue

  async laneOccupancy(): Promise<Record<Lane, { waiting: OrderRecord[]; inFlight: OrderRecord[] }>> {
    const rows = await this.d.store.listByStatus([...WAITING_FOR_LANE, ...IN_FLIGHT]);
    const sortKey = (o: OrderRecord) => `${o.queuedAt ?? o.paidAt ?? o.createdAt}|${o.id}`;
    const out = { standard: { waiting: [] as OrderRecord[], inFlight: [] as OrderRecord[] }, block: { waiting: [] as OrderRecord[], inFlight: [] as OrderRecord[] } };
    for (const o of rows) {
      if (o.rescued) continue; // a self-rescued reveal does not occupy a lane slot
      (IN_FLIGHT.includes(o.status) ? out[o.lane].inFlight : out[o.lane].waiting).push(o);
    }
    out.standard.waiting.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    out.block.waiting.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return out;
  }

  /** Block-lane item for the packing maths (ADR-0005 §4). */
  blockItem(r: Pick<OrderRecord, 'id' | 'tier' | 'quote'>): BlockLaneItem {
    const rule = tierRule(r.tier, this.d.settings.collection);
    return { id: r.id, weight: r.quote?.revealWeight ?? 0, sharesBlock: rule?.sharesBlock ?? false };
  }

  /**
   * Block slots: slot 1 is what is in flight (revealing / unconfirmed), waiting orders are packed
   * behind it by weight budget. An order's queue position is its slot index; ETA = slot x ~10 min.
   */
  blockSlots(occ: Awaited<ReturnType<OrderService['laneOccupancy']>>): BlockSlot[] {
    return packBlockSlots(occ.block.waiting.map((o) => this.blockItem(o)), {
      inFlight: occ.block.inFlight.map((o) => this.blockItem(o)),
    });
  }

  /** Slot a NEW order of `weight`/`tier` would open or join, given the current queue. */
  blockSlotForNew(occ: Awaited<ReturnType<OrderService['laneOccupancy']>>, tier: Tier, weight: number): number {
    const probe: BlockLaneItem = { id: '\u0000new', weight, sharesBlock: tierRule(tier, this.d.settings.collection)?.sharesBlock ?? false };
    const slots = packBlockSlots([...occ.block.waiting.map((o) => this.blockItem(o)), probe], {
      inFlight: occ.block.inFlight.map((o) => this.blockItem(o)),
    });
    return blockSlotOf(slots, probe.id) ?? slots.length;
  }

  private async queueInfo(r: OrderRecord): Promise<QueueInfo | null> {
    if (!WAITING_FOR_LANE.includes(r.status)) return null;
    const occ = await this.laneOccupancy();
    const idx = occ[r.lane].waiting.findIndex((o) => o.id === r.id);
    if (idx < 0) return null;
    if (r.lane === 'block') {
      const position = blockSlotOf(this.blockSlots(occ), r.id) ?? idx + 1;
      return { lane: 'block', position, etaMinutes: position * BLOCK_INTERVAL_MINUTES };
    }
    return { lane: 'standard', position: idx + 1, etaMinutes: BLOCK_INTERVAL_MINUTES };
  }

  async queueSnapshot(): Promise<QueueResponse> {
    const occ = await this.laneOccupancy();
    let tipHeight: number | null = null;
    try {
      tipHeight = this.d.chain ? await this.d.chain.getTipHeight() : null;
    } catch {
      tipHeight = null;
    }
    const slots = this.blockSlots(occ);
    const inFlightWeight = occ.block.inFlight.reduce((a, o) => a + (o.quote?.revealWeight ?? 0), 0);
    return {
      standard: {
        lane: 'standard',
        waiting: occ.standard.waiting.length,
        inFlight: occ.standard.inFlight.length,
        capacity: this.d.settings.standardConcurrency,
        weightBudget: null,
        inFlightWeight: 0,
        etaMinutesForNext: BLOCK_INTERVAL_MINUTES,
      },
      block: {
        lane: 'block',
        waiting: occ.block.waiting.length,
        inFlight: occ.block.inFlight.length,
        capacity: 1,
        weightBudget: BLOCK_LANE_WEIGHT_BUDGET,
        inFlightWeight,
        // Conservative: an order that opens a new slot (e.g. a Full Block Degent).
        etaMinutesForNext: (slots.length + 1) * BLOCK_INTERVAL_MINUTES,
      },
      tipHeight,
    };
  }

  async publicOrder(r: OrderRecord): Promise<Order> {
    return toPublicOrder(r, await this.queueInfo(r));
  }

  // ---------------------------------------------------------------- API use cases

  async createOrder(body: unknown): Promise<CreateOrderResponse> {
    const req = parseCreateOrder(body);
    const s = this.d.settings;
    const meta = validateContentMeta(
      { contentType: req.contentType, contentLength: req.contentLength, tier: req.tier },
      s.collection,
    );
    if (!meta.ok) throw invalid('content metadata violates the collection rules', { checks: meta.checks });
    const recipientError = checkRecipientAddress(req.recipientAddress, s.network);
    if (recipientError) throw invalid(recipientError);
    if (req.feeRate < s.collection.minFeeRate) throw invalid(`feeRate must be >= ${s.collection.minFeeRate} sat/vB`, { minFeeRate: s.collection.minFeeRate });
    if (req.artworkId !== undefined) return this.createArtworkOrder(req, req.artworkId);

    const now = this.now();
    const expiresAt = new Date(now.getTime() + s.collection.quoteTtlSeconds * 1000);
    // The lane comes out of the exact weight (ADR-0005 §3), so quote first, then check the lane's fee band.
    const quote = await this.quoteForNew({
      tier: req.tier,
      contentType: req.contentType,
      body: { length: req.contentLength },
      recipientAddress: req.recipientAddress,
      revealPubkey: req.revealPubkey,
      feeRate: req.feeRate,
      expiresAt,
    });
    const record = await this.createRecord(req, quote, now);
    return { order: await this.publicOrder(record), orderToken: record.token };
  }

  /**
   * Quote a new order and enforce the lane's fee band and the block-lane capacity (queue_full). Shared by
   * plain orders (indicative quote from the declared length) and artwork orders (binding quote from the
   * studio's bytes with the attribution metadata).
   */
  private async quoteForNew(q: {
    tier: Tier;
    contentType: string;
    body: Uint8Array | { length: number };
    recipientAddress: string;
    revealPubkey: string;
    feeRate: number;
    expiresAt: Date;
    artwork?: ArtworkQuoteInput;
  }) {
    const s = this.d.settings;
    const occ = await this.laneOccupancy();
    const draft = computeQuote({
      network: s.network,
      config: s.collection,
      tier: q.tier,
      contentType: q.contentType,
      body: q.body,
      parentId: s.collection.parentInscriptionId,
      collectionAddress: s.collectionAddress,
      recipientAddress: q.recipientAddress,
      revealPubkey: hexToBytes(q.revealPubkey),
      feeRate: q.feeRate,
      expiresAt: q.expiresAt,
      queuePosition: null,
      ...(q.artwork ? { artwork: q.artwork } : {}),
    });
    const lane = draft.lane;
    const band = s.policy.bands[lane];
    const minRate = Math.max(s.collection.minFeeRate, band.minFeeRate);
    if (q.feeRate < minRate) throw invalid(`feeRate must be >= ${minRate} sat/vB`, { minFeeRate: minRate });
    if (q.feeRate > band.maxFeeRate) throw invalid(`feeRate must be <= ${band.maxFeeRate} sat/vB for the ${lane} lane`);

    let queuePosition: number | null = null;
    if (lane === 'block') {
      // Block slots are limited by weight. Refuse new ones when the slot this order would get lies
      // beyond the rescue timeout: we would be selling a parent link we cannot deliver in time.
      queuePosition = this.blockSlotForNew(occ, q.tier, draft.revealWeight);
      const etaSeconds = queuePosition * BLOCK_INTERVAL_MINUTES * 60;
      if (etaSeconds > s.collection.rescueAfterSeconds * 0.8)
        throw new DomainError('queue_full', 503, 'the block lane queue is full; try again later', { slot: queuePosition });
    }
    return { ...draft, queuePosition, etaMinutes: lane === 'block' ? queuePosition! * BLOCK_INTERVAL_MINUTES : null };
  }

  /** Persist a new order in `awaiting_content` and emit the creation event. */
  private async createRecord(
    req: CreateOrderRequest,
    quote: NonNullable<OrderRecord['quote']>,
    now: Date,
    extra: Partial<OrderRecord> = {},
  ): Promise<OrderRecord & { token: string }> {
    const s = this.d.settings;
    const token = this.d.newToken?.() ?? randomBytes(32).toString('base64url');
    const at = now.toISOString();
    const record: OrderRecord = {
      id: this.newId(),
      network: s.network,
      status: 'awaiting_content',
      tier: req.tier,
      lane: quote.lane,
      contentType: req.contentType,
      contentLength: req.contentLength,
      contentSha256: req.contentSha256,
      recipientAddress: req.recipientAddress,
      revealPubkey: req.revealPubkey,
      quote,
      review: null,
      commitOutpoint: null,
      revealTxid: null,
      inscriptionId: null,
      rescued: false,
      serviceFeeAddress: quote.serviceFeeSats > 0 || (quote.clubFeeSats ?? 0) > 0 ? s.serviceFeeAddress : null,
      timeline: [{ status: 'awaiting_content', at }],
      createdAt: at,
      updatedAt: at,
      version: 0,
      expiresAt: quote.expiresAt,
      orderTokenHash: hashToken(token).toString('hex'),
      hasReveal: false,
      paidAt: null,
      queuedAt: null,
      revealHex: null,
      revealWeight: null,
      broadcastAttempts: 0,
      lastError: null,
      parentOutpoint: null,
      ...extra,
    };
    await this.d.store.create(record);
    await this.d.events.publish({
      type: 'degent.mint.order.awaiting_content',
      eventId: `${record.id}:1`,
      orderId: record.id,
      network: record.network,
      status: 'awaiting_content',
      previousStatus: null,
      at,
      lane: quote.lane,
    });
    return { ...record, token };
  }

  // ---------------------------------------------------------------- Open Studio artwork orders (plan §3)

  /** Fetch the artwork and refuse everything the plan says to refuse (§3.1). */
  private async mintableArtwork(artworkId: string): Promise<StudioArtwork & { contentSha256: string; payoutAddress: string; payoutScriptType: PayoutScriptType }> {
    const studio = this.d.studio;
    if (!studio) throw invalid('artwork orders are not enabled on this service (no studio configured)');
    let art: StudioArtwork | null;
    try {
      art = await studio.getArtwork(artworkId);
    } catch (e) {
      this.log.warn('studio unavailable', { artworkId, error: e instanceof Error ? e.message : String(e) });
      throw new DomainError('upstream_unavailable', 503, 'the studio is temporarily unavailable; retry');
    }
    if (!art) throw new DomainError('artwork_not_found', 404, `artwork ${artworkId} not found in the studio`);
    if (art.status !== 'approved' || !art.contentSha256)
      throw new DomainError('artwork_not_mintable', 409, `artwork ${artworkId} is ${art.status}, not approved`, { status: art.status });
    // Edition cap (ADR-0012), cheap early refusal from the studio's count; the binding check is the
    // reservation below, which also counts this service's live quotes.
    if (art.maxEditions != null && (art.mintedEditions ?? 0) >= art.maxEditions) throw soldOut(artworkId, art.maxEditions, art.mintedEditions ?? 0);
    if (!art.payoutAddress) throw new DomainError('artist_payout_missing', 409, 'the artist has not proven a payout address yet; the royalty cannot be paid');
    const scriptType = payoutScriptTypeOf(addressKind(art.payoutAddress, this.d.settings.network));
    if (!scriptType)
      throw new DomainError('artist_payout_missing', 409, `the artist's payout address is not a P2WPKH / P2TR address on ${this.d.settings.network}`);
    return { ...art, contentSha256: art.contentSha256, payoutAddress: art.payoutAddress, payoutScriptType: scriptType };
  }

  /**
   * An order for an approved studio artwork: content facts and bytes come from the studio, the review
   * happened at submission (ADR-0007 §4), the edition is reserved for the quote's TTL (§3.4) and the order
   * is returned `approved` with a binding quote carrying the club fee and the royalty (§3.1).
   */
  private async createArtworkOrder(req: CreateOrderRequest, artworkId: string): Promise<CreateOrderResponse> {
    const s = this.d.settings;
    const art = await this.mintableArtwork(artworkId);
    if (req.contentType !== art.contentType || req.contentLength !== art.contentLength || req.contentSha256 !== art.contentSha256)
      throw new DomainError('content_mismatch', 422, 'declared content facts differ from the artwork record', {
        artwork: { contentType: art.contentType, contentLength: art.contentLength, contentSha256: art.contentSha256 },
      });
    let bytes: Uint8Array | null;
    try {
      bytes = await this.d.studio!.getContent(artworkId);
    } catch (e) {
      this.log.warn('studio content unavailable', { artworkId, error: e instanceof Error ? e.message : String(e) });
      throw new DomainError('upstream_unavailable', 503, 'the studio is temporarily unavailable; retry');
    }
    if (!bytes || bytes.length !== art.contentLength || sha256Hex(bytes) !== art.contentSha256) {
      this.log.error('studio served bytes that do not match its artwork record', { artworkId });
      throw new DomainError('upstream_unavailable', 503, 'the studio content does not match the artwork record; retry later');
    }
    const clubFeeBps = s.clubFeeBps[req.tier];
    if (clubFeeBps > 0 && !s.serviceFeeAddress) throw new DomainError('internal', 500, 'club fee configured without SERVICE_FEE_ADDRESS');

    const now = this.now();
    const expiresAt = new Date(now.getTime() + s.collection.quoteTtlSeconds * 1000);
    const id = this.newId();
    // Reserve the edition first: it is signed into the envelope, so the quote depends on it (§3.4). The cap
    // is enforced inside the reservation (ADR-0012), so two concurrent quotes for the last edition cannot
    // both succeed.
    let edition: number;
    try {
      edition = await this.d.editions.reserve(artworkId, id, expiresAt, now, { maxEditions: art.maxEditions ?? null });
    } catch (e) {
      if (e instanceof EditionsSoldOutError) throw soldOut(artworkId, e.maxEditions, e.held);
      throw e;
    }
    let quote: NonNullable<OrderRecord['quote']>;
    try {
      quote = await this.quoteForNew({
        tier: req.tier,
        contentType: art.contentType,
        body: bytes,
        recipientAddress: req.recipientAddress,
        revealPubkey: req.revealPubkey,
        feeRate: req.feeRate,
        expiresAt,
        artwork: { artworkId, artistAddress: art.payoutAddress, edition, payoutScriptType: art.payoutScriptType, clubFeeBps, royaltyBps: s.royaltyBps },
      });
    } catch (e) {
      await this.d.editions.release(artworkId, id);
      throw e;
    }
    await this.d.content.put(bytes);
    const review: ReviewResult = {
      approved: true,
      reasons: [],
      checks: [{ id: 'artwork', passed: true, detail: `artwork ${artworkId} reviewed at submission by the studio` }],
    };
    // The record takes the id the edition was reserved under, so the reservation never changes hands.
    const created = await this.createRecord({ ...req, contentType: art.contentType }, quote, now, {
      id,
      artworkId,
      artistAddress: art.payoutAddress,
      artistRoyaltySats: quote.artistRoyaltySats ?? 0,
      clubFeeSats: quote.clubFeeSats ?? 0,
      royaltyPaid: null,
      royaltyReport: null,
      ledger: null,
    });
    const { token, ...record0 } = created;
    let r: OrderRecord = record0;
    r = await this.transition(r, 'reviewing', { detail: `artwork ${artworkId} reviewed at submission`, patch: { review } });
    r = await this.transition(r, 'approved', { detail: 'binding quote issued' });
    r = await this.recordLedger(r);
    return { order: await this.publicOrder(r), orderToken: token };
  }

  /** The envelope content of an order: bytes, parent tag and, for artwork orders, the attribution metadata (§3.4). */
  contentOf(r: OrderRecord, bytes: Uint8Array): InscriptionContent {
    const attribution =
      isArtworkOrder(r) && r.quote?.edition !== undefined && r.artistAddress
        ? attributionFor({ artworkId: r.artworkId!, artistAddress: r.artistAddress, edition: r.quote.edition })
        : undefined;
    return inscriptionContent(r.contentType, bytes, this.d.settings.collection.parentInscriptionId, attribution);
  }

  /** The reservation becomes the edition (at `paid`). Null when the number was lost to another order. */
  async consumeEdition(r: OrderRecord, now: Date): Promise<number | null> {
    if (!isArtworkOrder(r) || r.quote?.edition === undefined) return null;
    return this.d.editions.consume(r.artworkId!, r.id, r.quote.edition, now);
  }

  /**
   * Release the artwork edition this order holds back to the pool — an active reservation (quote expired,
   * commit never funded) or an already-consumed one (security review item 11: `rescue_available` / `expired`
   * / `failed`, or a funding tx observed dropped, must not burn the edition forever when the mint never
   * actually delivered it). Refuses in two cases:
   *
   *  - `hasConfirmedReveal(r)`: this order's own reveal (parent-linked, or a self-rescue of it) already
   *    confirmed on chain. A real inscription exists, so the assignment is permanent and correct.
   *  - The artist WAS paid (`r.royaltyPaid` set) in a funding transaction that could STILL be reported:
   *    `reportRoyalty` keeps retrying such orders from every status up to and including `rescue_available`
   *    until the funding confirms, so the studio would still be told about — and count — that payment. This
   *    is checked against the chain right now rather than trusted from the stored flag alone: if that same
   *    funding transaction has since vanished (evicted/replaced, the same condition `releaseVanishedFunding`
   *    watches for), `reportRoyalty`'s own confirmation gate (`worker.ts`) can never fire for it either, so
   *    there is nothing left to double-count and the release is safe. A reservation that never produced a
   *    royalty at all (`royaltyPaid` stayed null — short/missing artist output, or the number was lost to
   *    another order before payment) was, by construction, never counted by the studio either way.
   *
   * Idempotent (releaseHeld no-ops once the reservation is gone) and safe under the artwork's reservation
   * lock; a released edition can be re-assigned to a new order.
   */
  async releaseEdition(r: OrderRecord): Promise<void> {
    if (!isArtworkOrder(r) || hasConfirmedReveal(r)) return;
    if (r.royaltyPaid != null && (await this.fundingStillReportable(r))) return;
    await this.d.editions.releaseHeld(r.artworkId!, r.id);
  }

  /** Could `reportRoyalty` still report this order's funding transaction? Defaults to yes when unsure. */
  private async fundingStillReportable(r: OrderRecord): Promise<boolean> {
    if (!r.commitOutpoint || !this.d.chain) return true;
    try {
      return (await this.d.chain.getTx(r.commitOutpoint.txid)) !== null;
    } catch {
      return true; // chain unreachable: assume it could still land, don't release on a guess
    }
  }

  /**
   * Ledger order + psbt intent for an artwork order (plan §3.5). Best effort: failures are logged and
   * retried by the worker with backoff; a mint never waits for the ledger.
   */
  async recordLedger(r: OrderRecord): Promise<OrderRecord> {
    const ledger = this.d.ledger;
    if (!ledger || !isArtworkOrder(r) || !r.quote?.commitAddress) return r;
    const st = r.ledger ?? INITIAL_LEDGER;
    if (st.paymentId) return r;
    const now = this.now();
    if (st.nextAttemptAt && now.getTime() < Date.parse(st.nextAttemptAt)) return r;
    const keys = ledgerIdempotencyKeys(r.id);
    const s = this.d.settings;
    let orderId = st.orderId;
    try {
      if (!orderId) {
        const o = await ledger.createOrder({
          customerRef: r.recipientAddress,
          lineItems: buildLedgerLineItems(r, s),
          metadata: { mintOrderId: r.id, artworkId: r.artworkId!, edition: String(r.quote.edition ?? ''), tier: r.tier, network: r.network },
          idempotencyKey: keys.order,
        });
        orderId = o.id;
        if (o.totalSats !== r.quote.totalSats) this.log.warn('ledger total differs from the quote', { orderId: r.id, ledger: o.totalSats, quote: r.quote.totalSats });
      }
      const expiresAt = new Date(Date.parse(r.expiresAt) + s.latePaymentWindowSeconds * 1000).toISOString();
      const p = await ledger.createPsbtPayment(orderId, { expiresAt, idempotencyKey: keys.payment });
      const expected = p.outputs.reduce((a, o) => a + o.valueSats, 0);
      if (p.outputs.length && expected !== r.quote.totalSats) this.log.warn('ledger expected outputs differ from the quote', { orderId: r.id, expected, quote: r.quote.totalSats });
      this.log.info('ledger recorded', { orderId: r.id, ledgerOrderId: orderId, ledgerPaymentId: p.id });
      return await this.patch(r, { ledger: { ...INITIAL_LEDGER, orderId, paymentId: p.id, attempts: st.attempts + 1 } });
    } catch (e) {
      const attempts = st.attempts + 1;
      const error = e instanceof Error ? e.message : String(e);
      const retryable = e instanceof LedgerClientError ? e.retryable : true;
      this.log.warn('ledger recording failed; will retry', { orderId: r.id, attempts, error, retryable });
      const nextAttemptAt = new Date(now.getTime() + retryDelayMs(attempts) * (retryable ? 1 : 4)).toISOString();
      return this.patch(r, { ledger: { ...INITIAL_LEDGER, orderId, attempts, nextAttemptAt, lastError: error } });
    }
  }

  /**
   * Ledger 1.2: report the funding transaction the worker verified so the ledger evaluates it and records the
   * payouts (plan §3.5). Reported once while unconfirmed (the ledger answers `pending`) and once more when
   * confirmed; retried with backoff; never blocks the mint.
   */
  async observeLedger(r: OrderRecord, funding: ChainTx, tipHeight: number): Promise<OrderRecord> {
    const ledger = this.d.ledger;
    const st = r.ledger;
    if (!ledger || !isArtworkOrder(r) || !st?.paymentId || st.observedConfirmed) return r;
    const now = this.now();
    if (st.nextAttemptAt && now.getTime() < Date.parse(st.nextAttemptAt)) return r;
    const confirmations = funding.confirmed && funding.blockHeight !== null ? Math.max(1, tipHeight - funding.blockHeight + 1) : 0;
    if (st.observedAt && confirmations === 0) return r; // already reported unconfirmed; wait for the block
    try {
      const res = await ledger.observePayment(st.paymentId, {
        txid: funding.txid,
        outputs: funding.vout.map((o) => ({ scriptHex: o.scriptHex.toLowerCase(), valueSats: Number(o.value) })),
        confirmations,
        rbfSignalled: funding.rbfSignalled,
      });
      this.log.info('ledger observation reported', { orderId: r.id, ledgerPaymentId: st.paymentId, applied: res.applied, reason: res.reason, paymentStatus: res.paymentStatus, payouts: res.payouts.length });
      return await this.patch(r, { ledger: { ...st, observedAt: now.toISOString(), observedConfirmed: confirmations >= 1, nextAttemptAt: null, lastError: null } });
    } catch (e) {
      const attempts = st.attempts + 1;
      const error = e instanceof Error ? e.message : String(e);
      const retryable = e instanceof LedgerClientError ? e.retryable : true;
      this.log.warn('ledger observation failed; will retry', { orderId: r.id, attempts, error, retryable });
      return this.patch(r, { ledger: { ...st, attempts, nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts) * (retryable ? 1 : 4)).toISOString(), lastError: error } });
    }
  }

  /**
   * After a verified royalty output (plan §3.3): emit `degent.mint.royalty.paid` once and POST the record to
   * the studio (retry with backoff, idempotent on orderId). Waits for a confirmation whenever the funding
   * transaction was unconfirmed when the payment was first detected (`r.fundingRbf`; `funding` is the current
   * chain view in that case): full-RBF is now standard relay/miner policy, so a mempool sighting alone -
   * BIP125 opt-in or not - is not a safe basis for telling the studio, and through it the artist, that they
   * were paid (security review p5.5). This never delays the order's own progress (paid/queued/reveal), only
   * the royalty record and notification.
   */
  async reportRoyalty(r: OrderRecord, funding: ChainTx | null): Promise<OrderRecord> {
    if (!isArtworkOrder(r) || !r.royaltyPaid || !r.artistAddress) return r;
    const royaltyPaid = r.royaltyPaid;
    const artist = r.artistAddress;
    const artworkId = r.artworkId!;
    let st = r.royaltyReport ?? INITIAL_ROYALTY_REPORT;
    if (st.reportedAt || st.gaveUp) return r;
    if (r.fundingRbf) {
      if (!funding) return r;
      if (!funding.confirmed) return r; // still unconfirmed and therefore still replaceable: pending
      r = await this.patch(r, { fundingRbf: false });
    }
    const now = this.now();
    const at = now.toISOString();
    if (!st.emittedAt) {
      const ev: RoyaltyPaidEvent = {
        type: 'degent.mint.royalty.paid',
        eventId: `${r.id}:royalty`,
        orderId: r.id,
        network: r.network,
        artworkId,
        artist,
        sats: royaltyPaid.sats,
        txid: royaltyPaid.txid,
        vout: royaltyPaid.vout,
        at: r.paidAt ?? at,
        ...(r.edition !== undefined ? { edition: r.edition } : {}),
      };
      await this.d.events.publish(ev);
      st = { ...st, emittedAt: at };
      r = await this.patch(r, { royaltyReport: st });
    }
    const studio = this.d.studio;
    if (!studio) return r;
    if (st.nextAttemptAt && now.getTime() < Date.parse(st.nextAttemptAt)) return r;
    try {
      const res = await studio.postRoyalty({
        orderId: r.id,
        artworkId,
        minterAddress: r.recipientAddress,
        royaltySats: royaltyPaid.sats,
        fundingTxid: royaltyPaid.txid,
        vout: royaltyPaid.vout,
        at: r.paidAt ?? at,
        ...(r.edition !== undefined ? { edition: r.edition } : {}),
      });
      this.log.info('royalty recorded in the studio', { orderId: r.id, artworkId: r.artworkId, created: res.created });
      return await this.patch(r, { royaltyReport: { ...st, reportedAt: at, attempts: st.attempts + 1, nextAttemptAt: null, lastError: null } });
    } catch (e) {
      const attempts = st.attempts + 1;
      const error = e instanceof Error ? e.message : String(e);
      const retryable = e instanceof StudioClientError ? e.retryable : true;
      if (!retryable) {
        this.log.error('studio refused the royalty record; operator attention needed', { orderId: r.id, artworkId: r.artworkId, error });
        return this.patch(r, { royaltyReport: { ...st, attempts, nextAttemptAt: null, lastError: error, gaveUp: true } });
      }
      this.log.warn('royalty record not accepted by the studio; will retry', { orderId: r.id, attempts, error });
      return this.patch(r, { royaltyReport: { ...st, attempts, nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)).toISOString(), lastError: error } });
    }
  }

  /** `collection.minted` (platform topic 1.1.0) for a delivered, parent-linked order. */
  async emitCollectionMinted(r: OrderRecord, mintedAt: string): Promise<void> {
    if (!r.inscriptionId || !r.revealTxid || r.rescued) return;
    const parentInscriptionId = this.d.settings.collection.parentInscriptionId;
    const ev: CollectionMintedEvent = {
      type: 'collection.minted',
      collectionId: COLLECTION_ID,
      network: r.network,
      inscriptionId: r.inscriptionId,
      ...(parentInscriptionId ? { parentInscriptionId } : {}),
      txid: r.revealTxid,
      orderId: r.id,
      contentHash: r.contentSha256,
      mintedAt,
      ...(isArtworkOrder(r)
        ? {
            artist: r.artistAddress,
            artworkId: r.artworkId,
            ...(r.edition !== undefined ? { edition: r.edition } : {}),
            ...(r.royaltyPaid ? { royalty: { txid: r.royaltyPaid.txid, vout: r.royaltyPaid.vout, sats: r.royaltyPaid.sats } } : {}),
          }
        : {}),
    };
    await this.d.events.publish(ev);
  }

  async uploadContent(orderId: string, authorization: string | undefined, bytes: Uint8Array): Promise<Order> {
    let r = await this.authorize(orderId, authorization);
    if (r.status !== 'awaiting_content') throw conflict(`content already received (status ${r.status})`, { status: r.status });
    if (this.now().getTime() > Date.parse(r.expiresAt)) throw new DomainError('quote_expired', 409, 'order expired; create a new order');
    if (bytes.length !== r.contentLength)
      throw new DomainError('content_mismatch', 422, `received ${bytes.length} bytes, declared ${r.contentLength}`);
    const sha = sha256Hex(bytes);
    if (sha !== r.contentSha256)
      throw new DomainError('content_mismatch', 422, 'sha256 of the uploaded bytes differs from the declared contentSha256', {
        declared: r.contentSha256,
        actual: sha,
      });

    // Review BEFORE any transition: if the reviewer is unavailable the order stays
    // awaiting_content and the upload can simply be retried.
    let review;
    try {
      review = await this.d.review.review({ orderId: r.id, declaredContentType: r.contentType, bytes });
    } catch (e) {
      throw new DomainError('review_unavailable', 503, 'automated review is temporarily unavailable; retry the upload');
    }

    r = await this.transition(r, 'reviewing', { detail: `review by ${this.d.review.name}` });
    if (!review.approved) {
      r = await this.transition(r, 'rejected', { detail: review.reasons.join('; ').slice(0, 500), patch: { review } });
      return this.publicOrder(r);
    }
    await this.d.content.put(bytes);
    const s = this.d.settings;
    const expiresAt = new Date(this.now().getTime() + s.collection.quoteTtlSeconds * 1000);
    const occ = await this.laneOccupancy();
    const quote = computeQuote({
      network: s.network,
      config: s.collection,
      tier: r.tier,
      contentType: r.contentType,
      body: bytes,
      parentId: s.collection.parentInscriptionId,
      collectionAddress: s.collectionAddress,
      recipientAddress: r.recipientAddress,
      revealPubkey: hexToBytes(r.revealPubkey),
      feeRate: r.quote!.feeRate,
      expiresAt,
      queuePosition: r.lane === 'block' ? this.blockSlotForNew(occ, r.tier, r.quote!.revealWeight) : null,
    });
    r = await this.transition(r, 'approved', { detail: 'binding quote issued', patch: { review, quote, expiresAt: quote.expiresAt } });
    return this.publicOrder(r);
  }

  async submitReveal(orderId: string, authorization: string | undefined, body: unknown): Promise<Order> {
    let r = await this.authorize(orderId, authorization);
    const req = parseSubmitReveal(body);
    if (r.status !== 'approved') throw conflict(`reveal cannot be submitted in status ${r.status}`, { status: r.status });
    if (this.now().getTime() > Date.parse(r.expiresAt)) throw new DomainError('quote_expired', 409, 'quote expired; create a new order');
    const quote = r.quote!;
    if (req.commitAddress !== undefined && req.commitAddress !== quote.commitAddress)
      throw new DomainError('reveal_invalid', 422, 'commitAddress differs from the service-computed commit address', {
        expected: quote.commitAddress,
      });
    const bytes = await this.d.content.get(r.contentSha256);
    if (!bytes) throw new DomainError('internal', 500, 'stored content missing');
    const s = this.d.settings;
    // For artwork orders the envelope carries the attribution metadata (plan §3.4): a reveal whose commit
    // script was built without it, or with another artist / artwork / edition, does not match and is refused.
    const content = this.contentOf(r, bytes);
    const commitOutpoint = { txid: req.commitTxid.toLowerCase(), vout: req.commitVout };
    // ADR-0005 §1: SIGHASH_ALL|ANYONECANPAY over [parent return, child]. The browser pre-committed
    // output 0 = (collection address, parent value); anything else is refused before it is stored.
    const res = verifyHalfSignedReveal({
      network: s.network,
      psbtBase64: req.halfSignedRevealPsbt,
      revealPubkey: hexToBytes(r.revealPubkey),
      content,
      expectedCommitOutpoint: commitOutpoint,
      expectedCommitValue: BigInt(quote.commitValueSats),
      expectedRecipientAddress: r.recipientAddress,
      expectedPostage: BigInt(quote.postageSats),
      expectedSighash: 'all_anyonecanpay',
      expectedParentReturnAddress: s.collectionAddress,
      expectedParentValue: BigInt(s.parentValueSats),
    });
    if (!res.ok) throw new DomainError('reveal_invalid', 422, `half-signed reveal rejected: ${res.reason}`);
    await this.d.reveals.put(r.id, req.halfSignedRevealPsbt);
    r = await this.transition(r, 'awaiting_payment', {
      detail: 'half-signed reveal verified and stored',
      patch: { hasReveal: true, commitOutpoint },
    });
    return this.publicOrder(r);
  }

  async getOrder(orderId: string): Promise<Order> {
    const r = await this.d.store.get(orderId);
    if (!r) throw notFound('order');
    return this.publicOrder(r);
  }

  /**
   * ADR-0005 §2: the service holds no transaction the user could broadcast alone (a 0x81 reveal
   * needs the parent). It returns the inputs for `buildResignedRescue`, which the browser runs with
   * the ephemeral key K_e from the user's recovery bundle.
   */
  async getRescue(orderId: string, authorization: string | undefined): Promise<RescueInputs> {
    const r = await this.authorize(orderId, authorization);
    if (r.status !== 'rescue_available')
      throw new DomainError('rescue_unavailable', 409, `rescue is not available in status ${r.status}`, { status: r.status });
    const s = this.d.settings;
    const quote = r.quote!;
    const bytes = await this.d.content.get(r.contentSha256);
    if (!bytes) throw new DomainError('internal', 500, 'stored content missing');
    const content = this.contentOf(r, bytes);
    const rescueWeight = estimateResignedRescueWeight({ content, recipientScript: addressToScript(r.recipientAddress, s.network) });
    const rescueFeeSats = quote.commitValueSats - quote.postageSats;
    let suggestedFeeRate = s.collection.minFeeRate;
    try {
      if (this.d.fees) suggestedFeeRate = Math.max(s.collection.minFeeRate, (await this.d.fees.getFees()).standard.normal);
    } catch {
      suggestedFeeRate = s.collection.minFeeRate;
    }
    return {
      orderId: r.id,
      network: r.network,
      commitTxid: r.commitOutpoint!.txid,
      commitVout: r.commitOutpoint!.vout,
      commitValueSats: quote.commitValueSats,
      contentType: r.contentType,
      contentLength: r.contentLength,
      contentSha256: r.contentSha256,
      parentInscriptionId: s.collection.parentInscriptionId,
      recipientAddress: r.recipientAddress,
      revealPubkey: r.revealPubkey,
      postageSats: quote.postageSats,
      rescueWeight,
      rescueFeeSats,
      rescueFeeRate: Math.round((rescueFeeSats / vsizeFromWeight(rescueWeight)) * 1000) / 1000,
      suggestedFeeRate,
      ...(isArtworkOrder(r) && r.quote?.edition !== undefined
        ? { artworkId: r.artworkId, artistAddress: r.artistAddress, edition: r.quote.edition }
        : {}),
    };
  }
}

// ------------------------------------------------------------------ request parsing

const CREATE_KEYS = ['tier', 'contentType', 'contentLength', 'contentSha256', 'recipientAddress', 'revealPubkey', 'feeRate', 'artworkId'];
const REVEAL_KEYS = ['commitTxid', 'commitVout', 'halfSignedRevealPsbt', 'commitAddress'];

function asObject(body: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new DomainError('bad_request', 400, 'JSON object body required');
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) throw invalid(`unknown field(s): ${unknown.join(', ')}`);
  return body as Record<string, unknown>;
}

export function parseCreateOrder(body: unknown): CreateOrderRequest {
  const o = asObject(body, CREATE_KEYS);
  const errors: string[] = [];
  if (!isTier(o.tier)) errors.push('tier must be "standard", "large" or "fullblock"');
  if (typeof o.contentType !== 'string' || o.contentType.length > 100) errors.push('contentType must be a string');
  if (!Number.isSafeInteger(o.contentLength) || (o.contentLength as number) <= 0) errors.push('contentLength must be a positive integer');
  if (!isSha256Hex(o.contentSha256)) errors.push('contentSha256 must be 64 lowercase hex characters');
  if (typeof o.recipientAddress !== 'string') errors.push('recipientAddress must be a string');
  if (typeof o.revealPubkey !== 'string' || !/^[0-9a-f]{64}$/.test(o.revealPubkey))
    errors.push('revealPubkey must be a 32-byte x-only public key in lowercase hex');
  else {
    try {
      schnorr.utils.lift_x(BigInt(`0x${o.revealPubkey}`));
    } catch {
      errors.push('revealPubkey is not a valid secp256k1 x-only point');
    }
  }
  if (typeof o.feeRate !== 'number' || !Number.isFinite(o.feeRate) || o.feeRate <= 0) errors.push('feeRate must be a positive number');
  else if (Math.round(o.feeRate * 1000) !== o.feeRate * 1000) errors.push('feeRate supports at most 3 decimals');
  if (o.artworkId !== undefined && (typeof o.artworkId !== 'string' || !ARTWORK_ID.test(o.artworkId)))
    errors.push('artworkId must be 1-64 characters of [A-Za-z0-9_-]');
  if (errors.length) throw invalid(errors.join('; '), { errors });
  return {
    tier: o.tier as Tier,
    contentType: (o.contentType as string).toLowerCase(),
    contentLength: o.contentLength as number,
    contentSha256: o.contentSha256 as string,
    recipientAddress: o.recipientAddress as string,
    revealPubkey: o.revealPubkey as string,
    feeRate: o.feeRate as number,
    ...(o.artworkId !== undefined ? { artworkId: o.artworkId as string } : {}),
  };
}

export function parseSubmitReveal(body: unknown): SubmitRevealRequest {
  const o = asObject(body, REVEAL_KEYS);
  const errors: string[] = [];
  if (typeof o.commitTxid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(o.commitTxid)) errors.push('commitTxid must be 64 hex characters');
  if (!Number.isSafeInteger(o.commitVout) || (o.commitVout as number) < 0 || (o.commitVout as number) > 0xffffffff)
    errors.push('commitVout must be a non-negative integer');
  if (typeof o.halfSignedRevealPsbt !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.halfSignedRevealPsbt))
    errors.push('halfSignedRevealPsbt must be base64');
  if (o.commitAddress !== undefined && typeof o.commitAddress !== 'string') errors.push('commitAddress must be a string');
  if (errors.length) throw invalid(errors.join('; '), { errors });
  return {
    commitTxid: o.commitTxid as string,
    commitVout: o.commitVout as number,
    halfSignedRevealPsbt: o.halfSignedRevealPsbt as string,
    ...(o.commitAddress !== undefined ? { commitAddress: o.commitAddress as string } : {}),
  };
}
