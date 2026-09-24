/**
 * The marketplace use cases: read listings, list (prepare → create), cancel, buy (prepare → submit).
 * Orchestrates the ports; every transaction rule lives in the settlement engine (domain/settlement) and
 * every sat-assignment rule in @bsh/inscription.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { hex } from '@scure/base';
import {
  INSCRIPTION_INPUT_INDEX,
  MAX_DUMMY_VALUE,
  OPEN_LISTING_STATUSES,
  SETTLEMENT_LAYOUT,
  SIGHASH_SINGLE_ANYONECANPAY,
  dustFor,
  presetsFromMempool,
  royaltyFor,
  type BuyPrepareResponse,
  type BuySubmitResponse,
  type ChallengeResponse,
  type CreateListingResponse,
  type FeesResponse,
  type HealthResponse,
  type Listing,
  type ListingInvalidReason,
  type ListingsResponse,
  type MarketConfig,
  type PrepareListingResponse,
} from '@bsh/degent-market-sdk';
import { DomainError, notFound } from '../domain/errors.js';
import { toPublicListing, type BuySession, type ListingRecord } from '../domain/listing.js';
import { makeSchemas, parseBody, type Schemas } from '../domain/validation.js';
import {
  assembleBuyerSigned,
  assertRawInscriptionToBuyer,
  buildBuyerPsbt,
  buildDummySplitPsbt,
  buildSellerTemplate,
  decodeAddress,
  extractSellerSignature,
  outpointKey,
  parsePsbt,
  paymentForOwner,
  verifyInputSignature,
  type Utxo,
} from '../domain/settlement/index.js';
import { BroadcastRejected, UpstreamError, type AddressUtxo, type MarketChain } from '../ports/chain.js';
import type { Clock } from '../ports/clock.js';
import type { CollectionMembership } from '../ports/membership.js';
import type { InscriptionLocation, OrdIndexer } from '../ports/ord.js';
import type { BuySessionStore, ListingStore } from '../ports/listing-store.js';
import type { MarketAuth } from './auth.js';
import type { ListingLifecycle } from './lifecycle.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { MarketSettings } from './settings.js';

export interface MarketServiceDeps {
  settings: MarketSettings;
  listings: ListingStore;
  sessions: BuySessionStore;
  chain: MarketChain;
  ord: OrdIndexer;
  membership: CollectionMembership;
  auth: MarketAuth;
  lifecycle: ListingLifecycle;
  clock: Clock;
  log?: Logger;
  /** Session id generator (tests may inject). */
  newId?: () => string;
}

export const LISTING_NOTE = 'Sign input #2 only, with SIGHASH_SINGLE|ANYONECANPAY (0x83). Your wallet shows the Degent being spent: that is the listing.';
export const BUY_NOTE = "Your wallet will show an inscription input being spent. That is the seller's Degent moving to you in output #1.";
export const DUMMY_NOTE =
  'Your wallet has no two small (600-1000 sat) UTXOs to pad the purchase. Sign this self-transfer to create them, wait for one confirmation, then buy.';

const invalidListing = (reason: ListingInvalidReason, message: string, txid?: string | null) =>
  new DomainError('listing_invalid', 409, message, { reason, ...(txid ? { txid } : {}) });

/** Run an upstream call; network failures become 503 `upstream_unavailable` (never a 500). */
async function upstream<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('upstream_unavailable', 503, `${what} is unavailable; try again shortly`);
  }
}

export class MarketService {
  readonly schemas: Schemas;
  private readonly log: Logger;
  private readonly newId: () => string;

  constructor(private readonly d: MarketServiceDeps) {
    this.schemas = makeSchemas(d.settings);
    this.log = d.log ?? silentLogger;
    this.newId = d.newId ?? (() => bytesToHex(randomBytes(16)));
  }

  get settings(): MarketSettings {
    return this.d.settings;
  }

  // ------------------------------------------------------------------ reads

  config(): MarketConfig {
    const s = this.d.settings;
    return {
      network: s.network,
      buysEnabled: s.buysEnabled,
      royaltyBps: s.royaltyBps,
      treasuryAddress: s.treasuryAddress,
      priceMinSats: s.priceMinSats,
      priceMaxSats: s.priceMaxSats,
      listingMaxDays: s.listingMaxDays,
      dummyValueSats: s.dummyValueSats,
      layout: SETTLEMENT_LAYOUT,
      explorerTxUrl: s.explorerTxUrl,
    };
  }

  async health(): Promise<HealthResponse> {
    const checks: HealthResponse['checks'] = {};
    try {
      await this.d.listings.listByStatus(['active']);
      checks.store = { ok: true };
    } catch {
      checks.store = { ok: false, detail: 'store unavailable' };
    }
    try {
      await this.d.chain.getFeeRecommendations();
      checks.chain = { ok: true };
    } catch {
      checks.chain = { ok: false, detail: 'chain backend unavailable' };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? 'ok' : 'degraded', version: this.d.settings.version, network: this.d.settings.network, buysEnabled: this.d.settings.buysEnabled, checks };
  }

  async fees(): Promise<FeesResponse> {
    return presetsFromMempool(await upstream('fee estimation', () => this.d.chain.getFeeRecommendations()));
  }

  private pub(r: ListingRecord): Listing {
    return toPublicListing(r, this.d.settings.royaltyBps);
  }

  async listings(): Promise<ListingsResponse> {
    const rows = (await this.d.listings.listByStatus(['active'])).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return { items: rows.map((r) => this.pub(r)), total: rows.length };
  }

  async listing(id: string): Promise<Listing> {
    const r = await this.d.listings.get(id);
    if (!r) throw notFound('listing');
    return this.pub(r);
  }

  // ---------------------------------------------------------------- helpers

  private async requireDegent(inscriptionId: string) {
    const ref = await upstream('the collection register', () => this.d.membership.lookup(inscriptionId));
    if (!ref) throw new DomainError('not_a_degent', 403, 'this inscription is not a Degent (not in the roster and not a child of the club parent)');
    return ref;
  }

  private async requireNotListed(inscriptionId: string): Promise<void> {
    const existing = await this.d.listings.get(inscriptionId);
    if (existing && OPEN_LISTING_STATUSES.includes(existing.status)) throw new DomainError('already_listed', 409, 'this Degent is already listed');
  }

  /** Where the inscription is now, and that the seller holds it there on an unspent outpoint. */
  private async locateOwned(inscriptionId: string, sellerAddress: string): Promise<InscriptionLocation> {
    const insc = await upstream('the inscription indexer', () => this.d.ord.getInscription(inscriptionId));
    if (!insc) throw new DomainError('not_found', 404, 'inscription not found in the indexer');
    if (insc.address !== sellerAddress) throw new DomainError('not_owner', 403, `inscription is held by ${insc.address ?? 'an unknown script'}, not ${sellerAddress}`);
    await this.checkValidity(inscriptionId, insc.outpoint, sellerAddress);
    return insc;
  }

  /** Listing validity: outpoint unspent; the inscription still there; still held by the seller. */
  async checkValidity(inscriptionId: string, location: string, sellerAddress: string): Promise<InscriptionLocation> {
    const [txid, vout] = location.split(':') as [string, string];
    const outspend = await upstream('the chain backend', () => this.d.chain.getOutspend(txid, Number(vout)));
    if (!outspend) throw invalidListing('unknown_outpoint', 'the listed outpoint is unknown to the chain backend');
    if (outspend.spent) throw invalidListing('spent', `the listed outpoint was already spent in ${outspend.txid ?? 'an unknown transaction'}`, outspend.txid);
    const insc = await upstream('the inscription indexer', () => this.d.ord.getInscription(inscriptionId));
    if (!insc) throw invalidListing('not_indexed', 'inscription not found in the indexer');
    if (insc.outpoint !== location) throw invalidListing('moved', `the inscription is at ${insc.outpoint}, not ${location}`);
    if (insc.address && insc.address !== sellerAddress) throw invalidListing('wrong_owner', 'the inscription is no longer held by the seller');
    return insc;
  }

  private assertRoyaltyPayable(priceSats: number): void {
    const s = this.d.settings;
    if (s.royaltyBps === 0 || !s.treasuryAddress) return;
    const royalty = royaltyFor(priceSats, s.royaltyBps);
    const dust = dustFor(decodeAddress(s.treasuryAddress, s.network).type);
    if (royalty < dust) throw new DomainError('validation_failed', 422, `price too low: the ${s.royaltyBps} bps royalty (${royalty} sats) would be below dust (${dust} sats)`);
  }

  // ------------------------------------------------------------------- list

  async challenge(body: unknown): Promise<ChallengeResponse> {
    const b = parseBody(this.schemas.challenge, body);
    await this.requireDegent(b.inscriptionId);
    return this.d.auth.challenge({ action: b.action, address: b.address, inscriptionId: b.inscriptionId, ...(b.action === 'list' ? { priceSats: b.priceSats! } : {}) });
  }

  async prepareListing(body: unknown): Promise<PrepareListingResponse> {
    const b = parseBody(this.schemas.listingPrepare, body);
    await this.requireDegent(b.inscriptionId);
    await this.requireNotListed(b.inscriptionId);
    paymentForOwner(b.sellerAddress, b.sellerPublicKey, this.d.settings.network);
    this.assertRoyaltyPayable(b.priceSats);
    const insc = await this.locateOwned(b.inscriptionId, b.sellerAddress);
    const [txid, vout] = insc.outpoint.split(':') as [string, string];
    const t = buildSellerTemplate({
      inscriptionUtxo: { txid, vout: Number(vout), value: insc.value },
      sellerAddress: b.sellerAddress,
      sellerPublicKey: b.sellerPublicKey,
      priceSats: b.priceSats,
      network: this.d.settings.network,
    });
    return {
      psbtHex: t.psbtHex,
      psbtBase64: t.psbtBase64,
      signIndex: 2,
      sighashType: 131,
      toSignInputs: [{ index: INSCRIPTION_INPUT_INDEX, address: b.sellerAddress, sighashTypes: [SIGHASH_SINGLE_ANYONECANPAY] }],
      inscription: { outpoint: insc.outpoint, offset: insc.offset, value: insc.value, contentType: insc.contentType, number: insc.number },
    };
  }

  async createListing(body: unknown): Promise<CreateListingResponse> {
    const b = parseBody(this.schemas.listingCreate, body);
    const degent = await this.requireDegent(b.inscriptionId);
    await this.requireNotListed(b.inscriptionId);
    paymentForOwner(b.sellerAddress, b.sellerPublicKey, this.d.settings.network);
    this.assertRoyaltyPayable(b.priceSats);
    await this.d.auth.verify({ action: 'list', address: b.sellerAddress, inscriptionId: b.inscriptionId, priceSats: b.priceSats }, b);

    const insc = await this.locateOwned(b.inscriptionId, b.sellerAddress);
    const [txid, vout] = insc.outpoint.split(':') as [string, string];
    const inscriptionUtxo = { txid, vout: Number(vout), value: insc.value };
    const network = this.d.settings.network;
    // Rebuild the template and compare byte-for-byte; then verify the signature cryptographically.
    const expected = buildSellerTemplate({ inscriptionUtxo, sellerAddress: b.sellerAddress, sellerPublicKey: b.sellerPublicKey, priceSats: b.priceSats, network });
    const sig = extractSellerSignature(b.signedPsbt, { unsignedTxHex: expected.unsignedTxHex, inscriptionUtxo, sellerAddress: b.sellerAddress, priceSats: b.priceSats, network });
    const template = parsePsbt(expected.psbtHex, { allowUnknownInputs: true, allowUnknownOutputs: true });
    if (!verifyInputSignature(template, INSCRIPTION_INPUT_INDEX, sig)) throw new DomainError('bad_seller_signature', 400, 'the seller signature does not verify');

    const now = this.d.clock.now();
    const record: ListingRecord = {
      inscriptionId: b.inscriptionId,
      inscriptionNumber: insc.number,
      degent,
      contentType: insc.contentType,
      outputValue: insc.value,
      location: insc.outpoint,
      satOffset: insc.offset,
      priceSats: b.priceSats,
      sellerAddress: b.sellerAddress,
      sellerPublicKey: b.sellerPublicKey,
      sellerSignature: sig,
      status: 'active',
      statusReason: null,
      settlementTxid: null,
      buyerAddress: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + b.expiresInDays * 86_400_000).toISOString(),
      lastCheckedAt: now.toISOString(),
      version: 0,
    };
    try {
      await this.d.listings.insert(record);
    } catch {
      throw new DomainError('already_listed', 409, 'this Degent is already listed');
    }
    await this.d.lifecycle.created(record);
    this.log.info('listed', { inscriptionId: record.inscriptionId, priceSats: record.priceSats, seller: record.sellerAddress });
    return { listing: this.pub(record) };
  }

  async cancelListing(id: string, body: unknown): Promise<Listing> {
    const b = parseBody(this.schemas.listingCancel, body);
    const r = await this.d.listings.get(id);
    if (!r || !OPEN_LISTING_STATUSES.includes(r.status)) throw new DomainError('not_found', 404, 'no open listing for this inscription');
    if (r.sellerAddress !== b.sellerAddress) throw new DomainError('not_seller', 403, 'not the seller of this listing');
    if (r.status !== 'active') throw new DomainError('listing_not_active', 409, 'a purchase is in flight; the listing cannot be cancelled now');
    await this.d.auth.verify({ action: 'cancel', address: b.sellerAddress, inscriptionId: id }, b);
    const saved = await this.d.lifecycle.transition(r, 'cancelled', 'cancelled by the seller');
    this.log.info('cancelled', { inscriptionId: id });
    return this.pub(saved);
  }

  // -------------------------------------------------------------------- buy

  private assertBuysEnabled(): void {
    if (!this.d.settings.buysEnabled) throw new DomainError('buys_paused', 503, 'Buying is paused until the settlement engine is verified on signet and externally reviewed.');
  }

  /** The buyer's confirmed UTXOs that are safe to spend: not excluded by the wallet, not inscribed per ord. */
  private async safeUtxos(address: string, exclude: readonly string[]): Promise<AddressUtxo[]> {
    const all = await upstream('the chain backend', () => this.d.chain.getAddressUtxos(address));
    const excluded = new Set(exclude);
    const out: AddressUtxo[] = [];
    for (const u of all) {
      if (!u.confirmed) continue;
      const key = outpointKey(u);
      if (excluded.has(key)) continue;
      if (this.d.settings.utxoSafetyCheck) {
        const ids = await upstream('the inscription indexer', () => this.d.ord.getOutpointInscriptions(key));
        if (ids.length > 0) continue;
      }
      out.push(u);
    }
    return out;
  }

  async buyPrepare(body: unknown): Promise<BuyPrepareResponse> {
    this.assertBuysEnabled();
    const b = parseBody(this.schemas.buyPrepare, body);
    const s = this.d.settings;
    await this.requireDegent(b.inscriptionId);
    const r = await this.d.listings.get(b.inscriptionId);
    if (!r) throw notFound('listing');
    if (r.status !== 'active' || !r.sellerSignature) throw new DomainError('listing_not_active', 409, `listing is ${r.status}`);
    if (r.sellerAddress === b.buyerAddress) throw new DomainError('own_listing', 400, 'you cannot buy your own listing');
    if (Date.parse(r.expiresAt) < this.d.clock.now().getTime()) throw new DomainError('listing_expired', 409, 'listing expired');
    paymentForOwner(b.buyerAddress, b.buyerPublicKey, s.network);
    await this.checkValidity(r.inscriptionId, r.location, r.sellerAddress);

    const feeRate = (await this.fees())[b.feeTier];
    const utxos = await this.safeUtxos(b.buyerAddress, [...b.excludeOutpoints, r.location]);
    const toUtxo = (u: AddressUtxo): Utxo => ({ txid: u.txid, vout: u.vout, value: u.value });
    const dummies = utxos
      .filter((u) => u.value >= BigInt(s.dummyValueSats) && u.value <= BigInt(MAX_DUMMY_VALUE))
      .sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0))
      .slice(0, 2);
    const dummyKeys = new Set(dummies.map(outpointKey));
    const payment = utxos.filter((u) => !dummyKeys.has(outpointKey(u))).map(toUtxo);
    const now = this.d.clock.now();
    const expiresAt = new Date(now.getTime() + s.buySessionTtlSeconds * 1000).toISOString();
    const sessionId = this.newId();
    const base = { id: sessionId, inscriptionId: r.inscriptionId, buyerAddress: b.buyerAddress, status: 'open' as const, txid: null, createdAt: now.toISOString(), expiresAt };

    if (dummies.length < 2) {
      const split = buildDummySplitPsbt({ buyerAddress: b.buyerAddress, buyerPublicKey: b.buyerPublicKey, paymentUtxos: payment, feeRate, dummyValue: s.dummyValueSats, network: s.network });
      await this.d.sessions.createSession({ ...base, kind: 'dummies', psbtHex: split.psbtHex, buyerInputIndexes: split.buyerInputIndexes, prevouts: split.prevouts, guard: null });
      return {
        kind: 'dummies',
        sessionId,
        expiresAt,
        psbtHex: split.psbtHex,
        psbtBase64: split.psbtBase64,
        toSignInputs: split.buyerInputIndexes.map((index) => ({ index, address: b.buyerAddress })),
        note: DUMMY_NOTE,
        summary: split.summary,
      };
    }

    const [txid, vout] = r.location.split(':') as [string, string];
    const built = buildBuyerPsbt({
      listing: { inscriptionId: r.inscriptionId, inscriptionUtxo: { txid, vout: Number(vout), value: r.outputValue }, satOffset: r.satOffset, sellerAddress: r.sellerAddress, priceSats: r.priceSats, sellerSignature: r.sellerSignature },
      buyerAddress: b.buyerAddress,
      buyerPublicKey: b.buyerPublicKey,
      dummyUtxos: dummies.map(toUtxo),
      paymentUtxos: payment,
      feeRate,
      royaltyBps: s.royaltyBps,
      treasuryAddress: s.treasuryAddress,
      network: s.network,
    });
    const buyerScriptHex = hex.encode(decodeAddress(b.buyerAddress, s.network).script);
    await this.d.sessions.createSession({
      ...base,
      kind: 'buy',
      psbtHex: built.psbtHex,
      buyerInputIndexes: built.buyerInputIndexes,
      prevouts: built.prevouts,
      guard: { satOffset: r.satOffset, postage: r.outputValue, buyerScriptHex },
    });
    return {
      kind: 'buy',
      sessionId,
      expiresAt,
      psbtHex: built.psbtHex,
      psbtBase64: built.psbtBase64,
      toSignInputs: built.buyerInputIndexes.map((index) => ({ index, address: b.buyerAddress })),
      note: BUY_NOTE,
      summary: built.summary,
      inscriptionDestination: { vout: built.destination.vout, offset: Number(built.destination.offset) },
    };
  }

  async buySubmit(body: unknown): Promise<BuySubmitResponse> {
    this.assertBuysEnabled();
    const b = parseBody(this.schemas.buySubmit, body);
    const session = await this.d.sessions.getSession(b.sessionId);
    if (!session) throw new DomainError('not_found', 404, 'unknown buy session');
    if (session.status !== 'open') throw new DomainError('session_closed', 409, 'this buy session was already used');
    if (Date.parse(session.expiresAt) < this.d.clock.now().getTime()) throw new DomainError('session_expired', 410, 'buy session expired; prepare again');

    const assembled = assembleBuyerSigned({ sessionPsbt: session.psbtHex, signedPsbt: b.signedPsbt, buyerInputIndexes: session.buyerInputIndexes });
    let listing: ListingRecord | null = null;
    if (session.kind === 'buy') {
      listing = await this.d.listings.get(session.inscriptionId);
      if (!listing || listing.status !== 'active') throw new DomainError('listing_not_active', 409, 'the listing is no longer active');
      if (!session.guard) throw new DomainError('internal', 500, 'buy session without a guard');
      // Final assertion on the exact bytes about to be broadcast (@bsh/inscription FIFO).
      assertRawInscriptionToBuyer(assembled.rawTxHex, new Map(session.prevouts.map(([k, v]) => [k, BigInt(v)])), {
        satOffset: session.guard.satOffset,
        postage: BigInt(session.guard.postage),
        buyerScript: hex.decode(session.guard.buyerScriptHex),
        inscriptionId: session.inscriptionId,
      });
      await this.checkValidity(listing.inscriptionId, listing.location, listing.sellerAddress);
    }

    if (!(await this.d.sessions.claimSession(session.id))) throw new DomainError('session_closed', 409, 'this buy session was already used');
    let txid: string;
    try {
      txid = await this.d.chain.broadcast(assembled.rawTxHex);
    } catch (e) {
      await this.d.sessions.finishSession(session.id, 'released');
      if (e instanceof BroadcastRejected) throw new DomainError('broadcast_rejected', 502, `the network rejected the transaction: ${e.message.slice(0, 200)}`);
      if (e instanceof UpstreamError) throw new DomainError('upstream_unavailable', 503, 'broadcast backend unavailable; try again shortly');
      throw e;
    }
    await this.d.sessions.finishSession(session.id, { txid });
    if (listing) {
      await this.d.lifecycle.transition(listing, 'pending', 'purchase broadcast', { txid, buyerAddress: session.buyerAddress });
      this.log.info('purchase broadcast', { inscriptionId: listing.inscriptionId, txid, buyer: session.buyerAddress });
    } else {
      this.log.info('padding split broadcast', { txid, buyer: session.buyerAddress });
    }
    return { txid, kind: session.kind, vsize: assembled.vsize, feeSats: Number(assembled.fee), explorerUrl: `${this.d.settings.explorerTxUrl}/${txid}` };
  }

  /** For the watcher: drop expired open sessions. */
  purgeSessions(): Promise<number> {
    return this.d.sessions.purgeSessions(this.d.clock.now().toISOString());
  }

  /** Test/ops helper: the session as stored (never exposed over HTTP). */
  getSession(id: string): Promise<BuySession | null> {
    return this.d.sessions.getSession(id);
  }
}
