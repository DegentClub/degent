/**
 * Application service: every order mutation (API or worker) goes through here so that each
 * transition is validated by the state machine, persisted with a timestamp and emitted as an event.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { addressToScript, estimateResignedRescueWeight, verifyHalfSignedReveal, vsizeFromWeight } from '@bsh/inscription';
import type {
  BlockLaneItem,
  BlockSlot,
  CreateOrderRequest,
  CreateOrderResponse,
  Lane,
  Order,
  OrderEvent,
  OrderStatus,
  QueueInfo,
  QueueResponse,
  RescueInputs,
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
import { checkRecipientAddress } from '../domain/address.js';
import { DomainError, conflict, invalid, notFound } from '../domain/errors.js';
import { IN_FLIGHT, WAITING_FOR_LANE, toPublicOrder, type OrderRecord } from '../domain/order.js';
import { computeQuote, inscriptionContent } from '../domain/quote.js';
import { transition as checkTransition } from '../domain/state-machine.js';
import type { ArtReview } from '../ports/art-review.js';
import type { ChainPort } from '../ports/chain.js';
import type { Clock } from '../ports/clock.js';
import type { ContentStore } from '../ports/content-store.js';
import type { EventBus } from '../ports/event-bus.js';
import type { FeePort } from '../ports/fees.js';
import type { OrderStore } from '../ports/order-store.js';
import type { RevealVault } from '../ports/reveal-vault.js';
import type { MintSettings } from './settings.js';

export interface OrderServiceDeps {
  settings: MintSettings;
  store: OrderStore;
  content: ContentStore;
  reveals: RevealVault;
  review: ArtReview;
  events: EventBus;
  clock: Clock;
  chain?: ChainPort;
  /** Used only for the rescue's `suggestedFeeRate`; falls back to the collection minimum. */
  fees?: FeePort;
  newId?: () => string;
  newToken?: () => string;
}

const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest();

export class OrderService {
  constructor(private readonly d: OrderServiceDeps) {}

  get settings(): MintSettings {
    return this.d.settings;
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

    const now = this.now();
    const expiresAt = new Date(now.getTime() + s.collection.quoteTtlSeconds * 1000);
    const occ = await this.laneOccupancy();
    // The lane comes out of the exact weight (ADR-0005 §3), so quote first, then check the lane's fee band.
    const draft = computeQuote({
      network: s.network,
      config: s.collection,
      tier: req.tier,
      contentType: req.contentType,
      body: { length: req.contentLength },
      parentId: s.collection.parentInscriptionId,
      collectionAddress: s.collectionAddress,
      recipientAddress: req.recipientAddress,
      revealPubkey: hexToBytes(req.revealPubkey),
      feeRate: req.feeRate,
      expiresAt,
      queuePosition: null,
    });
    const lane = draft.lane;
    const band = s.policy.bands[lane];
    const minRate = Math.max(s.collection.minFeeRate, band.minFeeRate);
    if (req.feeRate < minRate) throw invalid(`feeRate must be >= ${minRate} sat/vB`, { minFeeRate: minRate });
    if (req.feeRate > band.maxFeeRate) throw invalid(`feeRate must be <= ${band.maxFeeRate} sat/vB for the ${lane} lane`);

    let queuePosition: number | null = null;
    if (lane === 'block') {
      // Block slots are limited by weight. Refuse new ones when the slot this order would get lies
      // beyond the rescue timeout: we would be selling a parent link we cannot deliver in time.
      queuePosition = this.blockSlotForNew(occ, req.tier, draft.revealWeight);
      const etaSeconds = queuePosition * BLOCK_INTERVAL_MINUTES * 60;
      if (etaSeconds > s.collection.rescueAfterSeconds * 0.8)
        throw new DomainError('queue_full', 503, 'the block lane queue is full; try again later', { slot: queuePosition });
    }
    const quote = { ...draft, queuePosition, etaMinutes: lane === 'block' ? queuePosition! * BLOCK_INTERVAL_MINUTES : null };

    const token = this.d.newToken?.() ?? randomBytes(32).toString('base64url');
    const at = now.toISOString();
    const record: OrderRecord = {
      id: this.newId(),
      network: s.network,
      status: 'awaiting_content',
      tier: req.tier,
      lane,
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
      serviceFeeAddress: quote.serviceFeeSats > 0 ? s.serviceFeeAddress : null,
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
      lane,
    });
    return { order: await this.publicOrder(record), orderToken: token };
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
    const content = inscriptionContent(r.contentType, bytes, s.collection.parentInscriptionId);
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
    const content = inscriptionContent(r.contentType, bytes, s.collection.parentInscriptionId);
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
    };
  }
}

// ------------------------------------------------------------------ request parsing

const CREATE_KEYS = ['tier', 'contentType', 'contentLength', 'contentSha256', 'recipientAddress', 'revealPubkey', 'feeRate'];
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
  if (errors.length) throw invalid(errors.join('; '), { errors });
  return {
    tier: o.tier as Tier,
    contentType: (o.contentType as string).toLowerCase(),
    contentLength: o.contentLength as number,
    contentSha256: o.contentSha256 as string,
    recipientAddress: o.recipientAddress as string,
    revealPubkey: o.revealPubkey as string,
    feeRate: o.feeRate as number,
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
