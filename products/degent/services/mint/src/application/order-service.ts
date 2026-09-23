/**
 * Application service: every order mutation (API or worker) goes through here so that each
 * transition is validated by the state machine, persisted with a timestamp and emitted as an event.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { buildRescueReveal, verifyHalfSignedReveal } from '@bsh/inscription';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  Lane,
  Order,
  OrderEvent,
  OrderStatus,
  QueueInfo,
  QueueResponse,
  RescueResponse,
  SubmitRevealRequest,
  Tier,
} from '@bsh/degent-mint-sdk';
import { BLOCK_INTERVAL_MINUTES, isSha256Hex, sha256Hex, tierForSize, validateContentMeta } from '@bsh/degent-mint-sdk';
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

  private async queueInfo(r: OrderRecord): Promise<QueueInfo | null> {
    if (!WAITING_FOR_LANE.includes(r.status)) return null;
    const occ = (await this.laneOccupancy())[r.lane];
    const idx = occ.waiting.findIndex((o) => o.id === r.id);
    if (idx < 0) return null;
    if (r.lane === 'block') {
      const position = idx + 1 + occ.inFlight.length;
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
    const block = occ.block.waiting.length + occ.block.inFlight.length;
    return {
      standard: {
        lane: 'standard',
        waiting: occ.standard.waiting.length,
        inFlight: occ.standard.inFlight.length,
        capacity: this.d.settings.standardConcurrency,
        etaMinutesForNext: BLOCK_INTERVAL_MINUTES,
      },
      block: {
        lane: 'block',
        waiting: occ.block.waiting.length,
        inFlight: occ.block.inFlight.length,
        capacity: 1,
        etaMinutesForNext: (block + 1) * BLOCK_INTERVAL_MINUTES,
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
    const lane = tierForSize(req.contentLength, s.collection)!.lane;
    const band = s.policy.bands[lane];
    const minRate = Math.max(s.collection.minFeeRate, band.minFeeRate);
    if (req.feeRate < minRate) throw invalid(`feeRate must be >= ${minRate} sat/vB`, { minFeeRate: minRate });
    if (req.feeRate > band.maxFeeRate) throw invalid(`feeRate must be <= ${band.maxFeeRate} sat/vB for the ${lane} lane`);

    const now = this.now();
    const expiresAt = new Date(now.getTime() + s.collection.quoteTtlSeconds * 1000);
    const occ = await this.laneOccupancy();
    if (lane === 'block') {
      // Block Degents are one per block. Refuse new ones when the queue alone would outlast the
      // rescue timeout: we would be selling a parent link we cannot deliver in time.
      const ahead = occ.block.waiting.length + occ.block.inFlight.length;
      const etaSeconds = (ahead + 1) * BLOCK_INTERVAL_MINUTES * 60;
      if (etaSeconds > s.collection.rescueAfterSeconds * 0.8)
        throw new DomainError('queue_full', 503, 'the Block Degent queue is full; try again later', { ahead });
    }
    const quote = computeQuote({
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
      queuePosition: occ.block.waiting.length + occ.block.inFlight.length + 1,
    });

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
      queuePosition: occ.block.waiting.length + occ.block.inFlight.length + 1,
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
    const res = verifyHalfSignedReveal({
      network: s.network,
      psbtBase64: req.halfSignedRevealPsbt,
      revealPubkey: hexToBytes(r.revealPubkey),
      content,
      expectedCommitOutpoint: commitOutpoint,
      expectedCommitValue: BigInt(quote.commitValueSats),
      expectedRecipientAddress: r.recipientAddress,
      expectedPostage: BigInt(quote.postageSats),
    });
    if (!res.ok) throw new DomainError('reveal_invalid', 422, `half-signed reveal rejected: ${res.reason}`);
    // The same PSBT must also be a valid self-rescue; prove it now, not after the user has paid.
    try {
      buildRescueReveal({ network: s.network, halfSignedPsbtBase64: req.halfSignedRevealPsbt });
    } catch (e) {
      throw new DomainError('reveal_invalid', 422, `half-signed reveal is not rescuable: ${(e as Error).message}`);
    }
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

  async getRescue(orderId: string, authorization: string | undefined): Promise<RescueResponse> {
    const r = await this.authorize(orderId, authorization);
    if (r.status !== 'rescue_available')
      throw new DomainError('rescue_unavailable', 409, `rescue is not available in status ${r.status}`, { status: r.status });
    const psbt = await this.d.reveals.get(r.id);
    if (!psbt) throw new DomainError('internal', 500, 'stored reveal missing');
    const rescue = buildRescueReveal({ network: this.d.settings.network, halfSignedPsbtBase64: psbt });
    return { orderId: r.id, txid: rescue.txid, hex: rescue.hex, weight: rescue.weight };
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
  if (o.tier !== 'standard' && o.tier !== 'block') errors.push('tier must be "standard" or "block"');
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
