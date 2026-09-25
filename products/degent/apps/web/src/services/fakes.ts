/**
 * Fakes for every port. Used by the tests and by `?demo=1` (clearly labelled DEMO in the UI).
 *
 * They are honest where it is cheap to be: the fake wallet holds real keys and really signs the
 * funding PSBT with @scure/btc-signer, and the fake chain derives txids from the raw bytes, so the
 * funding-txid safety check runs for real. The inscription maths (commit address, reveal) is
 * simulated deterministically: it is NOT @bsh/inscription and must never touch real funds.
 */
import * as btc from '@scure/btc-signer';
import { base64, base64url, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import type {
  ServiceConfig,
  CreateOrderRequest,
  Network,
  Order,
  OrderStatus,
  Quote,
  RescueInputs,
  SubmitRevealRequest,
} from '@bsh/degent-mint-sdk';
import {
  BLOCK_LANE_WEIGHT_BUDGET,
  DEGENT_RULES,
  DEGENT_RULES_CONFIG,
  DEGENT_RULES_VERSION,
  laneForWeight,
  readImageInfo,
  sniffContentType,
  TIER_LABELS,
  tierForSize,
  validateContentMeta,
} from '@bsh/degent-mint-sdk';
import type {
  ChainApi,
  CreateOrderRequestExt,
  EncodedImage,
  FeeSnapshot,
  ImageTools,
  InscriptionContentInput,
  InscriptionOps,
  MintApi,
  OrderExt,
  QueueSnapshot,
  QuoteExt,
  Services,
  SourceImage,
  Utxo,
  WalletId,
  WalletOption,
  WalletService,
  WalletSession,
} from './types';
import {
  StudioApiError,
  type Appeal,
  type ArtworkList,
  type ArtworkStatus,
  type HouseReview,
  type AutomatedReview,
  type RoyaltyRecord,
  type StudioApi,
  type StudioArtist,
  type StudioArtwork,
  type StudioConfig,
  type StudioReviewCheck,
} from './studioApi';
import { classifyAddress, scureNetwork } from '../lib/funding';
import { payoutAddressKind, payoutMessage, PAYOUT_MESSAGE_TEMPLATE } from '../lib/studioSession';
import { createFakeSite, type FakeSite, type FakeSiteOptions, type FakeSiteState } from './fakeSite';

const enc = new TextEncoder();
const sha256Hex = (b: Uint8Array) => hex.encode(sha256(b));
const dsha = (b: Uint8Array) => sha256(sha256(b));

export type CallLog = string[];

// ------------------------------------------------------------------ config

export function demoConfig(network: Network): ServiceConfig {
  return {
    network,
    collectionAddress: fakeCollectionAddress(network),
    parentValueSats: 10_000,
    serviceFeeAddress: fakeAddress('degent-service-fee', network),
    maxUploadBytes: 4 * 1024 * 1024,
    collectionName: 'Decentralized Gentlemen Club',
    parentInscriptionId: 'a'.repeat(64) + 'i0',
    allowedContentTypes: ['image/webp', 'image/jpeg', 'image/png', 'image/avif', 'image/gif'],
    tiers: [
      {
        tier: 'standard',
        minBytes: 200_000,
        maxBytes: 400_000,
        lane: 'standard',
        sharesBlock: true,
        label: TIER_LABELS.standard,
        description: 'Usually relays through the normal mempool, many per block. The last few KB of the range travel the block lane.',
      },
      {
        tier: 'large',
        minBytes: 400_001,
        maxBytes: 3_499_999,
        lane: 'block',
        sharesBlock: true,
        label: TIER_LABELS.large,
        description: 'Non-standard relay. Shares a block with other Large Degents when their weights fit the budget.',
      },
      {
        tier: 'fullblock',
        minBytes: 3_500_000,
        maxBytes: 3_900_000,
        lane: 'block',
        sharesBlock: false,
        label: TIER_LABELS.fullblock,
        description: 'Fills a Bitcoin block on its own. Always revealed alone.',
      },
    ],
    maxDimensionPx: 4096,
    minDimensionPx: 500,
    postageSats: 546,
    serviceFeeSats: { standard: 25_000, large: 100_000, fullblock: 250_000 },
    minFeeRate: 1,
    quoteTtlSeconds: 900,
    rescueAfterSeconds: 6 * 3600,
  };
}

// ------------------------------------------------------------------ inscription (simulated)

function validXOnly(seed: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(sha256(seed));
}

export function fakeCommitAddress(
  pubkeyHex: string,
  contentSha256: string,
  contentType: string,
  parentId: string | undefined,
  network: Network,
): string {
  const seed = enc.encode(`commit|${pubkeyHex}|${contentSha256}|${contentType}|${parentId ?? ''}|${network}`);
  return btc.p2tr(validXOnly(seed), undefined, scureNetwork(network)).address!;
}

export function fakeAddress(label: string, network: Network): string {
  const pub = secp256k1.getPublicKey(sha256(enc.encode(label)), true);
  return btc.p2wpkh(pub, scureNetwork(network)).address!;
}

/** The collection (parent) address is taproot, like the real one. */
export function fakeCollectionAddress(network: Network): string {
  return btc.p2tr(validXOnly(enc.encode('degent-collection')), undefined, scureNetwork(network)).address!;
}

/**
 * Simulated reveal weight, calibrated to the @bsh/inscription README table (parent-linked, P2TR):
 * body bytes + 3 WU per 520-byte PUSHDATA2 chunk + 966 WU of envelope/tx overhead + content type.
 * 390,000 B -> 393,226 WU, 400,000 B -> 403,286 WU (real: 393,226 / 403,285), so the lane boundary
 * (~396,700 bytes) falls where the real maths puts it. Never used for real money.
 */
export function fakeRevealWeight(contentLength: number, contentType: string): number {
  const chunks = Math.ceil(contentLength / 520);
  return contentLength + chunks * 3 + 966 + contentType.length;
}

export function createFakeInscription(log: CallLog = []): InscriptionOps {
  return {
    generateEphemeralKey() {
      log.push('inscription.generateEphemeralKey');
      const privkey = schnorr.utils.randomSecretKey();
      return { privkey, pubkeyHex: hex.encode(schnorr.getPublicKey(privkey)) };
    },
    commitAddress(pubkeyHex: string, content: InscriptionContentInput, network: Network) {
      log.push('inscription.commitAddress');
      return fakeCommitAddress(pubkeyHex, sha256Hex(content.body), content.contentType, content.parentId, network);
    },
    revealWeight(content) {
      return fakeRevealWeight(content.body.length, content.contentType);
    },
    buildHalfSignedReveal(args) {
      log.push('inscription.buildHalfSignedReveal');
      if (args.revealPrivkey.every((b) => b === 0)) throw new Error('reveal key was wiped');
      // Same preconditions as @bsh/inscription for 0x81 with a parent.
      if (!args.parentReturnAddress) throw new Error('parentReturnAddress is required for sighash all_anyonecanpay with a parent');
      if (typeof args.parentValue !== 'bigint' || args.parentValue <= 0n) throw new Error('parentValue must be a positive bigint');
      const payload = {
        simulated: true,
        commit: args.commitOutpoint,
        commitValue: args.commitValue.toString(),
        outputs: [
          { address: args.parentReturnAddress, value: args.parentValue.toString() },
          { address: args.recipientAddress, value: args.postage.toString() },
        ],
        sighash: '0x81',
        contentSha256: sha256Hex(args.content.body),
      };
      return { psbtBase64: base64.encode(enc.encode(JSON.stringify(payload))) };
    },
    buildResignedRescue(args) {
      log.push('inscription.buildResignedRescue');
      if (args.revealPrivkey.length !== 32 || args.revealPrivkey.every((b) => b === 0)) throw new Error('reveal key missing');
      if (args.commitValue <= args.postage) throw new Error('commitValue must exceed postage');
      const raw = sha256(
        enc.encode(
          `rescue|${hex.encode(args.revealPrivkey)}|${args.commitOutpoint.txid}:${args.commitOutpoint.vout}|${args.commitValue}|${args.recipientAddress}|${args.postage}|${sha256Hex(args.content.body)}`,
        ),
      );
      const weight = fakeRevealWeight(args.content.body.length, args.content.contentType) - 402 - 1;
      return { hex: hex.encode(raw), txid: hex.encode(dsha(raw).reverse()), weight, fee: args.commitValue - args.postage };
    },
    sha256Hex,
  };
}

// ------------------------------------------------------------------ chain

export interface FakeChainState {
  utxos: Map<string, Utxo[]>;
  broadcasts: string[];
  contents: Map<string, Uint8Array>;
  contentUrls: Map<string, string>;
}

export function createFakeChain(log: CallLog = [], state?: Partial<FakeChainState>): ChainApi & { state: FakeChainState } {
  const st: FakeChainState = {
    utxos: state?.utxos ?? new Map(),
    broadcasts: state?.broadcasts ?? [],
    contents: state?.contents ?? new Map(),
    contentUrls: state?.contentUrls ?? new Map(),
  };
  return {
    state: st,
    async getUtxos(address) {
      log.push('chain.getUtxos');
      const known = st.utxos.get(address);
      if (known) return known;
      // Every demo wallet is comfortably funded with two confirmed coins.
      return [0, 1].map((i) => ({
        txid: sha256Hex(enc.encode(`utxo|${address}|${i}`)),
        vout: i,
        value: i === 0 ? 3_500_000 : 900_000,
        status: { confirmed: true, block_height: 900_000 + i },
      }));
    },
    async broadcast(txHex) {
      log.push('chain.broadcast');
      st.broadcasts.push(txHex);
      const raw = hex.decode(txHex);
      try {
        return btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true }).id;
      } catch {
        return hex.encode(dsha(raw).reverse());
      }
    },
    async getInscriptionContent(id) {
      log.push('chain.getInscriptionContent');
      const c = st.contents.get(id);
      if (!c) throw new Error('not found');
      return c;
    },
    contentUrl(id) {
      const existing = st.contentUrls.get(id);
      if (existing) return existing;
      const c = st.contents.get(id);
      if (c && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([c.slice()]));
        st.contentUrls.set(id, url);
        return url;
      }
      return `about:blank#${id}`;
    },
  };
}

// ------------------------------------------------------------------ mint API

export type FakeScenario = 'happy' | 'rescue' | 'reject';

/** What the fake mint needs from the fake studio for artwork orders (plan §3.1). */
export interface FakeStudioHooks {
  artwork(id: string): StudioArtwork | undefined;
  artist(address: string): StudioArtist | undefined;
  content(id: string): Uint8Array | undefined;
  recordRoyalty(rec: Omit<RoyaltyRecord, 'artist' | 'recordedAt'>): void;
  /** The house decides a `reviewing` artwork (ADR-0012: resolves an open appeal: approve grants, reject denies). */
  houseReview?(id: string, decision: 'approve' | 'reject', reasons?: string[]): StudioArtwork;
}

/** Royalty split the fake mint applies (ADR-0007 §5: 10% of the mint price to the artist). */
export const FAKE_ROYALTY_BPS = 1000;

export interface FakeMintOptions {
  network: Network;
  scenario?: FakeScenario;
  /** Studio artworks the mint can sell (set by createFakeServices). */
  studio?: FakeStudioHooks;
  /** Service returns a commit address that does not match the browser's (tamper test). */
  tamperCommit?: boolean;
  /** GET /rescue fails (service gone) so the front end must build the rescue locally. */
  rescueEndpointDown?: boolean;
  fees?: FeeSnapshot;
  queue?: QueueSnapshot;
  chain?: FakeChainState;
  now?: () => number;
}

const PROGRESSION: Record<FakeScenario, OrderStatus[]> = {
  happy: ['paid', 'queued', 'revealing', 'revealed', 'confirmed', 'verified', 'delivered'],
  rescue: ['paid', 'queued', 'rescue_available'],
  reject: [],
};

export function createFakeMintApi(
  log: CallLog = [],
  opts: FakeMintOptions,
): MintApi & { orders: Map<string, Order>; tokenFor(id: string): string | undefined } {
  const config = demoConfig(opts.network);
  const orders = new Map<string, Order>();
  const bodies = new Map<string, Uint8Array>();
  const now = opts.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const scenario = opts.scenario ?? 'happy';
  let seq = 0;

  const push = (o: Order, status: OrderStatus, detail?: string, txid?: string): Order => {
    const at = iso();
    const ev: Order['timeline'][number] = { status, at };
    if (detail) ev.detail = detail;
    if (txid) ev.txid = txid;
    const next: Order = { ...o, status, updatedAt: at, timeline: [...o.timeline, ev] };
    orders.set(o.id, next);
    return next;
  };

  const requests = new Map<string, CreateOrderRequest>();
  const tokens = new Map<string, string>();
  const editions = new Map<string, number>();
  const auth = (id: string, token: string) => {
    if (!token) throw new Error('401 unauthorized: missing order token');
    if (tokens.get(id) !== token) throw new Error('403 forbidden: order token does not match');
  };
  const get = (id: string): Order => {
    const o = orders.get(id);
    if (!o) throw new Error(`order ${id} not found`);
    return o;
  };

  const quoteFor = (req: CreateOrderRequest, art?: { artworkId: string; artistAddress: string; edition: number }): Quote => {
    if (!config.tiers.some((t) => t.tier === req.tier)) throw new Error(`422 validation_failed: unknown tier ${req.tier}`);
    // ADR-0005 §3: the lane comes from the weight, not from the tier.
    const revealWeight = fakeRevealWeight(req.contentLength, req.contentType);
    const lane = laneForWeight(revealWeight);
    if (!lane) throw new Error(`422 validation_failed: reveal weight ${revealWeight} exceeds every lane`);
    const revealVsize = Math.ceil(revealWeight / 4);
    const revealFeeSats = Math.ceil(revealVsize * req.feeRate);
    const serviceFeeSats = config.serviceFeeSats[req.tier];
    const commitValueSats = revealFeeSats + config.postageSats;
    const commitAddress = fakeCommitAddress(
      req.revealPubkey,
      req.contentSha256,
      req.contentType,
      config.parentInscriptionId ?? undefined,
      opts.network,
    );
    const queue = opts.queue ?? { blockLaneLength: 3, blockLaneEtaMinutes: 30, standardLaneLength: 14 };
    // Studio artwork (ADR-0007 §5): mint price = twice the tier's service fee; 10% of it to the artist, the rest to the club.
    const mintPriceSats = art ? serviceFeeSats * 2 : 0;
    const artistRoyaltySats = art ? Math.floor((mintPriceSats * FAKE_ROYALTY_BPS) / 10_000) : 0;
    const clubFeeSats = art ? mintPriceSats - artistRoyaltySats : serviceFeeSats;
    const extras: Partial<QuoteExt> = art
      ? { clubFeeSats, artistRoyaltySats, artistAddress: art.artistAddress, artworkId: art.artworkId, mintPriceSats, edition: art.edition }
      : {};
    return {
      tier: req.tier,
      lane,
      feeRate: req.feeRate,
      revealWeight,
      revealVsize,
      revealFeeSats,
      postageSats: config.postageSats,
      serviceFeeSats: clubFeeSats,
      commitValueSats,
      totalSats: commitValueSats + clubFeeSats + artistRoyaltySats,
      commitAddress: opts.tamperCommit ? fakeAddress('attacker-commit', opts.network) : commitAddress,
      binding: true,
      expiresAt: new Date(now() + config.quoteTtlSeconds * 1000).toISOString(),
      queuePosition: lane === 'block' ? queue.blockLaneLength + 1 : null,
      etaMinutes: lane === 'block' ? (queue.blockLaneLength + 1) * 10 : 10,
      ...extras,
    } as Quote;
  };
  void BLOCK_LANE_WEIGHT_BUDGET;

  /**
   * Plan §3.1: an order for a studio artwork. The bytes are the studio's, reviewed at submission, so
   * the order is created `approved` with a BINDING quote (awaiting_content → reviewing → approved
   * recorded on the timeline) and no upload is needed. Output [1] of the funding tx is the royalty.
   */
  const createArtworkOrder = (artworkId: string, req: CreateOrderRequestExt) => {
    const art = opts.studio?.artwork(artworkId);
    if (!art) throw new Error(`404 artwork_not_found: no artwork ${artworkId}`);
    if (art.status !== 'approved' || !art.contentSha256) throw new Error(`422 artwork_not_mintable: artwork ${artworkId} is ${art.status}`);
    if (art.soldOut) throw new Error(`409 artwork_not_mintable: artwork ${artworkId} is sold out`);
    const artist = opts.studio?.artist(art.artist);
    if (!artist?.payoutAddress) throw new Error('422 artist_payout_missing: the artist has not proven a payout address');
    const bytes = opts.studio?.content(artworkId);
    if (!bytes) throw new Error(`422 artwork_not_mintable: artwork ${artworkId} has no content`);
    const tier = tierForSize(art.contentLength, config);
    if (!tier || tier.tier !== req.tier) throw new Error(`422 validation_failed: ${art.contentLength} bytes is not a ${req.tier} Degent`);
    if (req.contentSha256 !== art.contentSha256) throw new Error('422 content_mismatch: contentSha256 differs from the artwork');
    const edition = (editions.get(artworkId) ?? 0) + 1;
    editions.set(artworkId, edition);
    const full: CreateOrderRequest = {
      ...req,
      contentType: art.contentType,
      contentLength: art.contentLength,
      contentSha256: art.contentSha256,
    };
    const id = `ord_demo_${(++seq).toString().padStart(4, '0')}_${art.contentSha256.slice(0, 6)}`;
    const at = iso();
    const quote = quoteFor(full, { artworkId, artistAddress: artist.payoutAddress, edition });
    const aq = quote as QuoteExt;
    const order: OrderExt = {
      id,
      network: opts.network,
      status: 'approved',
      tier: req.tier,
      contentType: art.contentType,
      contentLength: art.contentLength,
      contentSha256: art.contentSha256,
      recipientAddress: req.recipientAddress,
      revealPubkey: req.revealPubkey,
      quote,
      review: {
        approved: true,
        reasons: [],
        checks: [{ id: 'studio', passed: true, detail: `Artwork ${artworkId} reviewed by the studio at submission` }],
      },
      rescued: false,
      queue: null,
      commitOutpoint: null,
      revealTxid: null,
      inscriptionId: null,
      serviceFeeAddress: fakeAddress('degent-service-fee', opts.network),
      timeline: [
        { status: 'awaiting_content', at },
        { status: 'reviewing', at, detail: `artwork ${artworkId} reviewed at submission` },
        { status: 'approved', at, detail: `artwork ${artworkId} reviewed at submission` },
      ],
      createdAt: at,
      updatedAt: at,
      artworkId,
      artistAddress: artist.payoutAddress,
      artistRoyaltySats: aq.artistRoyaltySats!,
      clubFeeSats: aq.clubFeeSats!,
      edition,
    };
    orders.set(id, order);
    requests.set(id, full);
    bodies.set(id, bytes);
    const orderToken = hex.encode(schnorr.utils.randomSecretKey());
    tokens.set(id, orderToken);
    return { order: order as Order, orderToken };
  };

  return {
    orders,
    tokenFor: (id: string) => tokens.get(id),
    async getConfig() {
      log.push('api.getConfig');
      return config;
    },
    async getFees() {
      log.push('api.getFees');
      return opts.fees ?? { economy: 2, normal: 4, priority: 9, minimum: 1, blockRecommended: 3, updatedAt: iso() };
    },
    async getQueue() {
      log.push('api.getQueue');
      return opts.queue ?? { blockLaneLength: 3, blockLaneEtaMinutes: 30, standardLaneLength: 14, updatedAt: iso() };
    },
    async createOrder(reqIn) {
      log.push('api.createOrder');
      const req = reqIn as CreateOrderRequestExt;
      const artworkId = typeof req.artworkId === 'string' && req.artworkId.length > 0 ? req.artworkId : null;
      if (artworkId) return createArtworkOrder(artworkId, req);
      const id = `ord_demo_${(++seq).toString().padStart(4, '0')}_${req.contentSha256.slice(0, 6)}`;
      const at = iso();
      const order: Order = {
        id,
        network: opts.network,
        status: 'awaiting_content',
        tier: req.tier,
        contentType: req.contentType,
        contentLength: req.contentLength,
        contentSha256: req.contentSha256,
        recipientAddress: req.recipientAddress,
        revealPubkey: req.revealPubkey,
        quote: { ...quoteFor(req), commitAddress: null, binding: false },
        review: null,
        rescued: false,
        queue: null,
        commitOutpoint: null,
        revealTxid: null,
        inscriptionId: null,
        serviceFeeAddress: fakeAddress('degent-service-fee', opts.network),
        timeline: [{ status: 'awaiting_content', at }],
        createdAt: at,
        updatedAt: at,
      };
      orders.set(id, order);
      requests.set(id, req);
      const orderToken = hex.encode(schnorr.utils.randomSecretKey());
      tokens.set(id, orderToken);
      return { order, orderToken };
    },
    async uploadContent(id, token, bytes) {
      log.push('api.uploadContent');
      auth(id, token);
      const o = get(id);
      if (sha256Hex(bytes) !== o.contentSha256) throw new Error('content hash does not match order');
      bodies.set(id, bytes);
      // The binding quote (with the commit address) only exists once the exact bytes are known.
      const binding = { ...o, quote: quoteFor(requests.get(id)!) };
      return push(binding, 'reviewing', 'Automated art review started');
    },
    async submitReveal(id, token, req: SubmitRevealRequest) {
      log.push('api.submitReveal');
      auth(id, token);
      const o = get(id);
      if (req.commitAddress && req.commitAddress !== o.quote?.commitAddress) throw new Error('409 commit address mismatch');
      if (o.status !== 'approved') throw new Error(`cannot submit reveal in status ${o.status}`);
      orders.set(id, { ...o, commitOutpoint: { txid: req.commitTxid, vout: req.commitVout } });
      return push(get(id), 'awaiting_payment', 'Half-signed reveal verified and stored');
    },
    async getOrder(id) {
      log.push('api.getOrder');
      const o = get(id);
      if (o.status === 'reviewing') {
        const approved = scenario !== 'reject';
        const checks = [
          { id: 'format', passed: true, detail: `${o.contentType}, ${o.contentLength} bytes` },
          { id: 'tuxedo', passed: approved, detail: approved ? 'Tuxedo detected' : 'No tuxedo found' },
          { id: 'bowtie', passed: approved, detail: approved ? 'Bowtie present' : 'Bowtie missing' },
          { id: 'text', passed: true, detail: 'Found “DEGENT”' },
        ];
        const reviewed = {
          ...o,
          review: { approved, reasons: approved ? [] : ['No bowtie. The bowtie is mandatory.'], checks },
        };
        orders.set(id, reviewed);
        return push(reviewed, approved ? 'approved' : 'rejected', approved ? 'Meets the brief' : 'Bowtie missing');
      }
      const path = PROGRESSION[scenario];
      const idx = path.indexOf(o.status);
      const next = o.status === 'awaiting_payment' ? path[0] : idx >= 0 ? path[idx + 1] : undefined;
      if (!next) return o;
      let cur = o;
      let txid: string | undefined;
      if (next === 'paid') {
        txid = o.commitOutpoint?.txid;
        // ADR-0007 §5 / plan §3.3: the mint verified output [1] paid the artist and records it.
        const ox = o as OrderExt;
        if (txid && ox.artworkId && typeof ox.artistRoyaltySats === 'number' && ox.artistRoyaltySats > 0) {
          const royaltyPaid = { txid, vout: 1, sats: ox.artistRoyaltySats };
          cur = { ...cur, royaltyPaid } as Order;
          opts.studio?.recordRoyalty({
            orderId: o.id,
            artworkId: ox.artworkId,
            minterAddress: o.recipientAddress,
            royaltySats: ox.artistRoyaltySats,
            fundingTxid: txid,
            vout: 1,
            at: iso(),
          });
        }
      }
      if (next === 'queued') {
        const pos = o.quote?.queuePosition ?? 1;
        cur = { ...cur, queue: { lane: o.quote?.lane ?? 'standard', position: pos, etaMinutes: pos * 10 } };
      }
      if (next === 'revealing') cur = { ...cur, queue: null };
      if (next === 'revealed') {
        const revealTxid = sha256Hex(enc.encode(`reveal|${id}`));
        const inscriptionId = `${revealTxid}i0`;
        const body = bodies.get(id);
        if (body && opts.chain) opts.chain.contents.set(inscriptionId, body);
        cur = { ...cur, revealTxid, inscriptionId };
        txid = revealTxid;
      }
      return push(cur, next, undefined, txid);
    },
    async getRescue(id, token): Promise<RescueInputs> {
      log.push('api.getRescue');
      if (opts.rescueEndpointDown) throw new Error('service unavailable');
      auth(id, token);
      const o = get(id);
      if (o.status !== 'rescue_available') throw new Error(`409 rescue_unavailable: rescue is not available in status ${o.status}`);
      const q = o.quote!;
      const rescueWeight = fakeRevealWeight(o.contentLength, o.contentType) - 403;
      const rescueFeeSats = q.commitValueSats - q.postageSats;
      return {
        orderId: id,
        network: opts.network,
        commitTxid: o.commitOutpoint!.txid,
        commitVout: o.commitOutpoint!.vout,
        commitValueSats: q.commitValueSats,
        contentType: o.contentType,
        contentLength: o.contentLength,
        contentSha256: o.contentSha256,
        parentInscriptionId: config.parentInscriptionId,
        recipientAddress: o.recipientAddress,
        revealPubkey: o.revealPubkey,
        postageSats: q.postageSats,
        rescueWeight,
        rescueFeeSats,
        rescueFeeRate: Math.round((rescueFeeSats / Math.ceil(rescueWeight / 4)) * 1000) / 1000,
        suggestedFeeRate: (opts.fees ?? { normal: 4 }).normal,
      };
    },
  };
}

// ------------------------------------------------------------------ wallet

export const WALLET_CATALOG: ReadonlyArray<Omit<WalletOption, 'installed'>> = [
  { id: 'unisat', name: 'UniSat', installUrl: 'https://unisat.io/download' },
  { id: 'xverse', name: 'Xverse', installUrl: 'https://www.xverse.app/download' },
  { id: 'leather', name: 'Leather', installUrl: 'https://leather.io/install-extension' },
  { id: 'okx', name: 'OKX Wallet', installUrl: 'https://www.okx.com/web3' },
  { id: 'magiceden', name: 'Magic Eden', installUrl: 'https://wallet.magiceden.io/download' },
];

export interface FakeWalletOptions {
  installed?: WalletId[];
  /** Payment address type the wallet reports. */
  paymentType?: 'p2wpkh' | 'p2sh-p2wpkh' | 'p2tr' | 'p2pkh';
  /** Wallet mutates the transaction before signing (should be caught by the txid check). */
  tamper?: boolean;
  /** Wallet shaves one sat off output 1 before signing (caught by the output script/value check). */
  tamperOutput?: boolean;
  rejectSign?: boolean;
  withPushTx?: boolean;
}

/**
 * Deterministic stand-in for a BIP-322 simple signature: a function of the address and the message
 * only, so the fake studio can verify it without the wallet's key. No real service accepts it.
 */
export function fakeMessageSignature(address: string, message: string): string {
  return base64.encode(sha256(enc.encode(`fake-bip322|${address}|${message}`)));
}

export function createFakeWallets(log: CallLog = [], opts: FakeWalletOptions = {}): WalletService {
  const installed = new Set<WalletId>(opts.installed ?? ['unisat', 'xverse']);
  return {
    list() {
      return WALLET_CATALOG.map((w) => ({ ...w, installed: installed.has(w.id) }));
    },
    async connect(id, network) {
      log.push(`wallet.connect:${id}`);
      const entry = WALLET_CATALOG.find((w) => w.id === id)!;
      if (!installed.has(id)) throw new Error(`${entry.name} is not installed`);
      const net = scureNetwork(network);
      const ordPriv = sha256(enc.encode(`demo-ord|${id}`));
      const payPriv = sha256(enc.encode(`demo-pay|${id}`));
      const ordX = schnorr.getPublicKey(ordPriv);
      const payPub = secp256k1.getPublicKey(payPriv, true);
      const ptype = opts.paymentType ?? 'p2wpkh';
      const paymentAddress =
        ptype === 'p2wpkh'
          ? btc.p2wpkh(payPub, net).address!
          : ptype === 'p2sh-p2wpkh'
            ? btc.p2sh(btc.p2wpkh(payPub, net), net).address!
            : ptype === 'p2tr'
              ? btc.p2tr(payPub.slice(1), undefined, net).address!
              : btc.p2pkh(payPub, net).address!;
      const session: WalletSession = {
        id,
        name: entry.name,
        network,
        ordinals: { address: btc.p2tr(ordX, undefined, net).address!, publicKey: hex.encode(ordX), addressType: 'p2tr' },
        payment: { address: paymentAddress, publicKey: hex.encode(payPub), addressType: ptype },
        async signPsbt(psbtBase64, req) {
          log.push('wallet.signPsbt');
          if (opts.rejectSign) throw new Error('User rejected the request.');
          const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64));
          if (opts.tamper) tx.updateInput(0, { sequence: 0xfffffffd }, true);
          if (opts.tamperOutput && tx.outputsLength > 1) tx.updateOutput(1, { amount: tx.getOutput(1).amount! - 1n }, true);
          for (const { index } of req.inputsToSign) tx.signIdx(payPriv, index);
          if (req.finalize) tx.finalize();
          return { psbtBase64: base64.encode(tx.toPSBT()) };
        },
        async signMessage(message, address, type = 'bip322-simple') {
          log.push('wallet.signMessage');
          if (opts.rejectSign) throw new Error('User rejected the request.');
          if (address !== session.ordinals.address && address !== session.payment.address) {
            throw new Error(`${entry.name}: ${address} is not one of this wallet’s addresses.`);
          }
          const kind = classifyAddress(address);
          if (type === 'bip322-simple' && kind !== 'p2tr' && kind !== 'p2wpkh') {
            throw new Error(`${entry.name} cannot produce a BIP-322 simple signature with a ${kind} address.`);
          }
          return fakeMessageSignature(address, message);
        },
        async disconnect() {
          log.push('wallet.disconnect');
        },
      };
      if (opts.withPushTx) {
        session.pushTx = async (txHex: string) => {
          log.push('wallet.pushTx');
          const raw = hex.decode(txHex);
          try {
            return btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true }).id;
          } catch {
            return hex.encode(dsha(raw).reverse()); // simulated (non-parseable) rescue hex
          }
        };
      }
      return session;
    },
  };
}

// ------------------------------------------------------------------ images

export interface FakeImageOptions {
  width?: number;
  height?: number;
  /** Bytes at quality 1, scale 1. Size scales ~ quality x scale^2. */
  fullSize?: number;
}

/** Deterministic encoder: size = fullSize * (0.08 + 0.92 * quality) * scale^2. */
export function fakeEncodedSize(fullSize: number, quality: number, scale: number): number {
  return Math.max(64, Math.round(fullSize * (0.08 + 0.92 * quality) * scale * scale));
}

function bytesOfSize(size: number, seed: string): Uint8Array {
  const out = new Uint8Array(size);
  const block = sha256(enc.encode(seed));
  for (let i = 0; i < size; i++) out[i] = block[i % 32]! ^ (i & 0xff);
  // RIFF....WEBP header so sniffing sees a WebP.
  out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50].slice(0, Math.min(12, size)), 0);
  return out;
}

export function createFakeImages(opts: FakeImageOptions = {}): ImageTools {
  const width = opts.width ?? 1600;
  const height = opts.height ?? 1600;
  const fullSize = opts.fullSize ?? 1_400_000;
  return {
    async decode(): Promise<SourceImage> {
      return { width, height, handle: null };
    },
    async encode(_src, o): Promise<EncodedImage> {
      const size = fakeEncodedSize(fullSize, o.quality, o.scale);
      const bytes = bytesOfSize(size, `${o.type}|${o.quality}|${o.scale}`);
      return {
        blob: new Blob([bytes.slice()], { type: 'image/webp' }),
        width: Math.round(width * o.scale),
        height: Math.round(height * o.scale),
      };
    },
    async sample() {
      return new Blob([bytesOfSize(fullSize, 'sample').slice()], { type: 'image/webp' });
    },
  };
}

// ------------------------------------------------------------------ generated PNGs (demo gallery)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(b: Uint8Array): number {
  let a = 1;
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]!) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

const u32be = (n: number): Uint8Array => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** zlib stream of stored (uncompressed) deflate blocks: valid for every PNG decoder, no compressor needed. */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let i = 0; i < data.length; i += 65535) {
    const chunk = data.subarray(i, i + 65535);
    const final = i + 65535 >= data.length ? 1 : 0;
    const len = chunk.length;
    parts.push(Uint8Array.of(final, len & 255, (len >> 8) & 255, ~len & 255, (~len >> 8) & 255), chunk);
  }
  parts.push(u32be(adler32(data)));
  return concat(parts);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([enc.encode(type), data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

/** A real 8-bit greyscale PNG (readable by `readImageInfo` and any browser), pixel value from `grey(x, y)`. */
export function generatePng(width: number, height: number, grey: (x: number, y: number) => number): Uint8Array {
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) raw[row + 1 + x] = Math.max(0, Math.min(255, Math.round(grey(x, y))));
  }
  const ihdr = concat([u32be(width), u32be(height), Uint8Array.of(8, 0, 0, 0, 0)]);
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibStored(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

const demoBytesCache = new Map<number, Uint8Array>();

/**
 * A framed square "gentleman" placeholder (dark frame, ivory mat, a placard band), 500 x 500 px,
 * ~250 KB: a Standard Degent by size, so the demo mint can quote and inscribe it.
 */
export function demoArtworkBytes(seed: number, side = 500): Uint8Array {
  const key = seed * 100_000 + side;
  const cached = demoBytesCache.get(key);
  if (cached) return cached;
  const frame = Math.round(side * 0.056);
  const mat = frame + Math.round(side * 0.024);
  const bytes = generatePng(side, side, (x, y) => {
    const d = Math.min(x, y, side - 1 - x, side - 1 - y);
    if (d < frame) return 38 + ((d >> 2) & 1) * 26;
    if (d < mat) return 214;
    const placard = y > side - mat - 74 && y < side - mat - 26 && x > side / 2 - 92 && x < side / 2 + 92;
    if (placard) return 18;
    return 128 + Math.sin(x / (13 + seed * 2) + seed) * 46 + Math.cos(y / (19 + seed) + seed * 1.7) * 46;
  });
  demoBytesCache.set(key, bytes);
  return bytes;
}

// ------------------------------------------------------------------ studio (simulated)

export interface FakeStudioOptions {
  network: Network;
  /** Verdict the fake review gives an upload that passes the byte rules. */
  reviewScenario?: 'approve' | 'reject' | 'needsHuman';
  /** `needsHuman`: the house approves after this many `getArtwork` polls (never, when unset). */
  houseResolvesAfterPolls?: number;
  /** Seed the three example artworks (default true). */
  seedGallery?: boolean;
  now?: () => number;
}

export interface FakeStudioState {
  artists: Map<string, StudioArtist>;
  artworks: Map<string, StudioArtwork>;
  /** sha256 → bytes */
  contents: Map<string, Uint8Array>;
  royalties: RoyaltyRecord[];
  sessions: Map<string, { address: string; expiresAt: number }>;
  /** artwork id → upload token */
  uploadTokens: Map<string, string>;
  challenges: Map<string, { address: string; message: string; expiresAt: number; used: boolean }>;
  polls: Map<string, number>;
  /** ADR-0012 §6: notification targets and the (never re-shown) webhook secret, per artist. */
  notify: Map<string, { webhookUrl: string | null; telegramChatId: string | null; secret: string | null }>;
}

export interface FakeStudio extends StudioApi {
  state: FakeStudioState;
  hooks: FakeStudioHooks;
}

export const DEMO_ARTISTS = {
  ada: { label: 'artist-ada', displayName: 'Ada of the Lily Pad' },
  bram: { label: 'artist-bram', displayName: 'Bram Frogsworth' },
} as const;

export interface DemoArtworkSeed {
  id: string;
  title: string;
  description: string;
  artist: keyof typeof DEMO_ARTISTS;
  featured: boolean;
  seed: number;
  /** A limited edition (ADR-0012); absent = open edition. */
  maxEditions?: number;
}

export const DEMO_ARTWORKS: readonly DemoArtworkSeed[] = [
  { id: 'art_demo_chairman', title: 'The Chairman', description: 'Pepe presides. Tuxedo by Savile Row, bowtie by decree.', artist: 'ada', featured: true, seed: 1 },
  { id: 'art_demo_martini', title: 'Martini Hour', description: 'Shaken, framed, placarded DEGENT.', artist: 'bram', featured: false, seed: 2 },
  { id: 'art_demo_regen', title: 'Regen at Dawn', description: 'A gentleman at first light, REGEN on the plaque.', artist: 'ada', featured: false, seed: 3, maxEditions: 25 },
];

/** Taproot identity address of a demo artist (what they sign in with). */
export function demoArtistAddress(artist: keyof typeof DEMO_ARTISTS, network: Network): string {
  return btc.p2tr(validXOnly(enc.encode(DEMO_ARTISTS[artist].label)), undefined, scureNetwork(network)).address!;
}

/** Native SegWit payout address of a demo artist (BIP-322-proven in the seed). */
export function demoArtistPayout(artist: keyof typeof DEMO_ARTISTS, network: Network): string {
  return fakeAddress(`${DEMO_ARTISTS[artist].label}-payout`, network);
}

function studioConfig(network: Network): StudioConfig {
  const cfg = DEGENT_RULES_CONFIG;
  return {
    network,
    rulesVersion: DEGENT_RULES_VERSION,
    rules: DEGENT_RULES.map((r) => ({ ...r })),
    recommendedContentType: 'image/jpeg',
    allowedContentTypes: [...cfg.allowedContentTypes],
    tiers: cfg.tiers.map((t) => ({ tier: t.tier, label: t.label, minBytes: t.minBytes, maxBytes: t.maxBytes })),
    minDimensionPx: cfg.minDimensionPx,
    maxDimensionPx: cfg.maxDimensionPx,
    maxUploadBytes: 4 * 1024 * 1024,
    titleMaxChars: 80,
    descriptionMaxChars: 500,
    displayNameMaxChars: 40,
    siwb: { domain: 'studio.degent.club', uri: 'https://studio.degent.club', ttlSeconds: 300 },
    session: { ttlSeconds: 3600, audience: 'degent', scopes: ['artist'] },
    payoutMessageTemplate: PAYOUT_MESSAGE_TEMPLATE,
    payoutAddressKinds: ['p2wpkh', 'p2tr'],
    visionReview: 'claude',
    maxEditionsLimit: 10_000,
    featuredRankMax: 1000,
    appealMessageMaxChars: 1000,
    appealsPerArtwork: 3,
    notifyChannels: ['webhook', 'telegram'],
  };
}

export function createFakeStudioApi(log: CallLog = [], opts: FakeStudioOptions): FakeStudio {
  const now = opts.now ?? (() => Date.now());
  const iso = (t = now()) => new Date(t).toISOString();
  const network = opts.network;
  const config = studioConfig(network);
  const st: FakeStudioState = {
    artists: new Map(),
    artworks: new Map(),
    contents: new Map(),
    royalties: [],
    sessions: new Map(),
    uploadTokens: new Map(),
    challenges: new Map(),
    polls: new Map(),
    notify: new Map(),
  };
  const dataUrls = new Map<string, string>();
  let seq = 0;

  const err = (status: number, code: string, message: string): never => {
    throw new StudioApiError(status, code, message);
  };
  const artistOf = (address: string): StudioArtist => {
    let a = st.artists.get(address);
    if (!a) {
      const at = iso();
      a = { address, network, displayName: null, payoutAddress: null, payoutVerifiedAt: null, artworks: { total: 0, approved: 0 }, joinedAt: at, updatedAt: at };
      st.artists.set(address, a);
    }
    return a;
  };
  const withCounts = (a: StudioArtist): StudioArtist => {
    const mine = [...st.artworks.values()].filter((w) => w.artist === a.address);
    const n = st.notify.get(a.address);
    return {
      ...a,
      artworks: { total: mine.length, approved: mine.filter((w) => w.status === 'approved').length },
      notify: { webhookUrl: n?.webhookUrl ?? null, telegramChatId: n?.telegramChatId ?? null, webhookSecretSet: !!n?.secret },
    };
  };
  const subOf = (token: string | undefined): string => {
    if (!token) return err(401, 'unauthorized', 'A studio session is required.');
    const s = st.sessions.get(token);
    if (!s || s.expiresAt <= now()) return err(401, 'unauthorized', 'The studio session is missing, invalid or expired.');
    return s.address;
  };
  /** The wire view: ADR-0012 edition facts always; appeals only for the owner (`owner` true). */
  const view = (w: StudioArtwork, owner = false): StudioArtwork => {
    const minted = st.royalties.filter((r) => r.artworkId === w.id).length;
    const max = w.maxEditions ?? null;
    const { appeals, ...rest } = w;
    return {
      ...rest,
      maxEditions: max,
      mintedEditions: minted,
      soldOut: max !== null && minted >= max,
      featuredRank: w.featuredRank ?? null,
      review: w.review ? { ...w.review } : null,
      timeline: [...w.timeline],
      ...(owner ? { appeals: (appeals ?? []).map((a) => ({ ...a })) } : {}),
    };
  };
  const tokenSub = (token: string | undefined): string | null => {
    try {
      return token ? subOf(token) : null;
    } catch {
      return null;
    }
  };
  const validMax = (v: unknown): v is number | null | undefined =>
    v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000);
  /** House verdict on a reviewing artwork; resolves the open appeal with the same reasons. */
  const decide = (w: StudioArtwork, decision: 'approve' | 'reject', reasons: string[]): StudioArtwork => {
    const house: HouseReview = { decision, reasons, reviewerId: 'key_house', at: iso() };
    const appeals = (w.appeals ?? []).map((a) =>
      a.status === 'open' ? { ...a, status: decision === 'approve' ? ('granted' as const) : ('denied' as const), resolvedAt: house.at, resolution: house } : a,
    );
    const resolved: StudioArtwork = { ...w, needsHuman: false, appeals, review: { automated: w.review?.automated ?? null, house, reviewedAt: house.at } };
    st.artworks.set(w.id, resolved);
    return push(resolved, decision === 'approve' ? 'approved' : 'rejected', decision === 'approve' ? 'The house approved it' : reasons[0]);
  };
  const push = (w: StudioArtwork, status: ArtworkStatus, detail?: string): StudioArtwork => {
    const at = iso();
    const next: StudioArtwork = {
      ...w,
      status,
      updatedAt: at,
      contentUrl: status === 'approved' ? `/v1/artworks/${w.id}/content` : null,
      timeline: [...w.timeline, { status, at, ...(detail ? { detail } : {}) }],
    };
    st.artworks.set(w.id, next);
    return next;
  };

  // Seed: two artists with proven payouts, three approved artworks (one featured).
  if (opts.seedGallery !== false) {
    for (const key of Object.keys(DEMO_ARTISTS) as Array<keyof typeof DEMO_ARTISTS>) {
      const a = artistOf(demoArtistAddress(key, network));
      st.artists.set(a.address, { ...a, displayName: DEMO_ARTISTS[key].displayName, payoutAddress: demoArtistPayout(key, network), payoutVerifiedAt: a.joinedAt });
    }
    DEMO_ARTWORKS.forEach((d, i) => {
      const bytes = demoArtworkBytes(d.seed);
      const sha = sha256Hex(bytes);
      st.contents.set(sha, bytes);
      const t0 = now() - (DEMO_ARTWORKS.length - i) * 86_400_000;
      const at = iso(t0);
      const w: StudioArtwork = {
        id: d.id,
        artist: demoArtistAddress(d.artist, network),
        network,
        title: d.title,
        description: d.description,
        contentType: 'image/png',
        contentLength: bytes.length,
        contentSha256: sha,
        status: 'approved',
        needsHuman: false,
        review: {
          automated: { approved: true, needsHuman: false, reasons: [], checks: [{ id: 'design', passed: true, detail: 'Tuxedo and bowtie present' }], reviewer: 'rules+vision' },
          house: null,
          reviewedAt: at,
        },
        featured: d.featured,
        featuredAt: d.featured ? at : null,
        ...(d.maxEditions ? { maxEditions: d.maxEditions } : {}),
        contentUrl: `/v1/artworks/${d.id}/content`,
        timeline: [
          { status: 'submitted', at },
          { status: 'reviewing', at },
          { status: 'approved', at, detail: 'Meets the brief' },
        ],
        createdAt: at,
        updatedAt: at,
      };
      st.artworks.set(w.id, w);
    });
  }

  const review = (w: StudioArtwork, bytes: Uint8Array): StudioArtwork => {
    const info = readImageInfo(bytes);
    const sniffed = sniffContentType(bytes);
    const v = validateContentMeta(
      { contentType: sniffed ?? w.contentType, contentLength: bytes.length, ...(info?.width && info?.height ? { width: info.width, height: info.height } : {}) },
      DEGENT_RULES_CONFIG,
    );
    const checks: StudioReviewCheck[] = [
      { id: 'magic_bytes', passed: sniffed === w.contentType, detail: sniffed ? `file header says ${sniffed}` : 'unrecognised file header' },
      ...v.checks,
    ];
    const rulesOk = checks.every((c) => c.passed);
    const reasons = [...v.reasons];
    if (sniffed !== w.contentType) reasons.push(`The bytes are ${sniffed ?? 'not a recognised image'}, not ${w.contentType}.`);
    let automated: AutomatedReview;
    let status: ArtworkStatus;
    if (!rulesOk) {
      automated = { approved: false, needsHuman: false, reasons, checks, reviewer: 'rules' };
      status = 'rejected';
    } else if ((opts.reviewScenario ?? 'approve') === 'approve') {
      automated = { approved: true, needsHuman: false, reasons: [], checks: [...checks, { id: 'design', passed: true, detail: 'Tuxedo and bowtie present' }, { id: 'framing', passed: true, detail: 'Framed, placard reads DEGENT' }], reviewer: 'rules+vision' };
      status = 'approved';
    } else if (opts.reviewScenario === 'reject') {
      automated = {
        approved: false,
        needsHuman: false,
        reasons: ['No bowtie. The bowtie is mandatory.'],
        checks: [...checks, { id: 'design', passed: false, detail: 'Bowtie missing' }, { id: 'framing', passed: true, detail: 'Framed, placard reads DEGENT' }],
        reviewer: 'rules+vision',
      };
      status = 'rejected';
    } else {
      automated = {
        approved: false,
        needsHuman: true,
        reasons: [],
        checks: [...checks, { id: 'design', passed: false, detail: 'skipped: no vision reviewer configured' }],
        reviewer: 'rules+human-gate',
      };
      status = 'reviewing';
    }
    const reviewedAt = iso();
    let next: StudioArtwork = { ...w, needsHuman: automated.needsHuman, review: { automated, house: null, reviewedAt } };
    st.artworks.set(next.id, next);
    next = push(next, 'reviewing', 'Automated review ran');
    if (status !== 'reviewing') next = push(next, status, status === 'approved' ? 'Meets the brief' : automated.reasons[0]);
    return next;
  };

  const api: FakeStudio = {
    state: st,
    hooks: {
      artwork: (id) => {
        const w = st.artworks.get(id);
        return w ? view(w) : undefined;
      },
      artist: (address) => st.artists.get(address),
      content: (id) => {
        const w = st.artworks.get(id);
        return w?.contentSha256 ? st.contents.get(w.contentSha256) : undefined;
      },
      recordRoyalty(rec) {
        const w = st.artworks.get(rec.artworkId);
        if (!w) return;
        if (st.royalties.some((r) => r.orderId === rec.orderId)) return;
        st.royalties.push({ ...rec, artist: w.artist, recordedAt: iso() });
      },
      houseReview(id, decision, reasons = []) {
        const w = st.artworks.get(id);
        if (!w || w.status !== 'reviewing') throw new StudioApiError(409, 'illegal_transition', `Artwork ${id} is not under review.`);
        return view(decide(w, decision, reasons), true);
      },
    },
    async getConfig() {
      log.push('studio.getConfig');
      return config;
    },
    async challenge(address, net) {
      log.push('studio.challenge');
      if (net !== network) return err(422, 'network_mismatch', `This studio serves ${network}, not ${net}.`);
      if (typeof address !== 'string' || address.length < 14) return err(422, 'validation_failed', 'address is not a Bitcoin address');
      const nonce = hex.encode(sha256(enc.encode(`nonce|${address}|${now()}|${++seq}`))).slice(0, 32);
      const issuedAt = iso();
      const expiresAt = now() + config.siwb.ttlSeconds * 1000;
      const message = [
        `${config.siwb.domain} wants you to sign in with your Bitcoin account:`,
        address,
        '',
        'Sign in to the degent.club Artist Studio.',
        '',
        `URI: ${config.siwb.uri}`,
        'Version: 1',
        `Network: ${network}`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
        `Expiration Time: ${iso(expiresAt)}`,
      ].join('\n');
      st.challenges.set(nonce, { address, message, expiresAt, used: false });
      return { message, nonce, address, network, issuedAt, expiresAt: iso(expiresAt) };
    },
    async verify(req) {
      log.push('studio.verify');
      const ch = [...st.challenges.values()].find((c) => c.message === req.message && c.address === req.address);
      if (!ch) return err(401, 'sign_in_failed', 'Unknown or altered challenge.');
      if (ch.used) return err(401, 'sign_in_failed', 'This challenge was already used.');
      if (ch.expiresAt <= now()) return err(401, 'sign_in_failed', 'The challenge expired; request a new one.');
      if (req.signature !== fakeMessageSignature(req.address, req.message)) return err(401, 'sign_in_failed', 'The signature does not verify for this address.');
      ch.used = true;
      const artist = artistOf(req.address);
      const token = `sess_${hex.encode(schnorr.utils.randomSecretKey())}`;
      const expiresAt = now() + config.session.ttlSeconds * 1000;
      st.sessions.set(token, { address: req.address, expiresAt });
      return { token, expiresAt: iso(expiresAt), method: 'bip322-simple', artist: withCounts(artist) };
    },
    async getMe(token) {
      log.push('studio.getMe');
      return withCounts(artistOf(subOf(token)));
    },
    async updateMe(token, req) {
      log.push('studio.updateMe');
      const sub = subOf(token);
      const a = artistOf(sub);
      let next = { ...a };
      if (req.displayName !== undefined) {
        if (req.displayName !== null && req.displayName.length > config.displayNameMaxChars) return err(422, 'validation_failed', 'displayName is too long');
        next.displayName = req.displayName === '' ? null : req.displayName;
      }
      if (req.payout) {
        const kind = payoutAddressKind(req.payout.address);
        if (kind === 'legacy') return err(422, 'payout_address_legacy', 'The payout address must be a SegWit (bc1q…) or Taproot (bc1p…) address.');
        if (kind === 'unknown') return err(422, 'validation_failed', 'The payout address is not a Bitcoin address.');
        if (req.payout.signature !== fakeMessageSignature(req.payout.address, payoutMessage(req.payout.address, sub))) {
          return err(422, 'payout_proof_invalid', 'The BIP-322 proof does not verify for that address and this session.');
        }
        next = { ...next, payoutAddress: req.payout.address, payoutVerifiedAt: iso() };
      }
      let secretOnce: string | null = null;
      if (req.notify !== undefined) {
        const cur = st.notify.get(sub) ?? { webhookUrl: null, telegramChatId: null, secret: null };
        let n = { ...cur };
        if (req.notify === null) n = { webhookUrl: null, telegramChatId: null, secret: null };
        else {
          const { webhookUrl, telegramChatId, rotateWebhookSecret } = req.notify;
          if (webhookUrl !== undefined) {
            if (webhookUrl !== null) {
              const why = fakeWebhookProblem(webhookUrl, network);
              if (why) return err(422, 'validation_failed', `notify.webhookUrl: ${why}`);
            }
            n.webhookUrl = webhookUrl;
            if (webhookUrl === null) n.secret = null;
          }
          if (telegramChatId !== undefined) {
            if (telegramChatId !== null && !/^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(telegramChatId)) {
              return err(422, 'validation_failed', 'notify.telegramChatId must be a numeric chat id or @channel.');
            }
            n.telegramChatId = telegramChatId;
          }
          if (n.webhookUrl && (!n.secret || rotateWebhookSecret)) {
            secretOnce = `whsec_${base64url.encode(schnorr.utils.randomSecretKey()).replace(/=+$/, '')}`;
            n.secret = secretOnce;
          } else if (rotateWebhookSecret && !n.webhookUrl) {
            return err(422, 'validation_failed', 'There is no webhook to rotate a secret for.');
          }
        }
        st.notify.set(sub, n);
      }
      next.updatedAt = iso();
      st.artists.set(sub, next);
      return { ...withCounts(next), ...(secretOnce ? { notifyWebhookSecret: secretOnce } : {}) };
    },
    async getMyRoyalties(token, page = 1, pageSize = 24) {
      log.push('studio.getMyRoyalties');
      const sub = subOf(token);
      const mine = st.royalties.filter((r) => r.artist === sub).sort((x, y) => (x.at < y.at ? 1 : -1));
      const start = (page - 1) * pageSize;
      return {
        items: mine.slice(start, start + pageSize),
        totals: { records: mine.length, royaltySats: mine.reduce((s, r) => s + r.royaltySats, 0) },
        page,
        pageSize,
        total: mine.length,
      };
    },
    async getArtist(address) {
      log.push('studio.getArtist');
      const a = st.artists.get(address);
      if (!a) return err(404, 'not_found', `No artist ${address}`);
      const c = withCounts(a);
      return { address: c.address, displayName: c.displayName, artworks: c.artworks.approved, joinedAt: c.joinedAt };
    },
    async listArtworks(query, token) {
      log.push('studio.listArtworks');
      const status = query.status ?? 'approved';
      let artist = query.artist;
      if (status !== 'approved') {
        const sub = subOf(token);
        if (artist === undefined) artist = sub;
        if (artist !== sub) return err(403, 'forbidden', 'Only your own artworks can be listed by status.');
      }
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 24;
      const rank = (w: StudioArtwork) => (w.featured && typeof w.featuredRank === 'number' ? w.featuredRank : Number.POSITIVE_INFINITY);
      const me = tokenSub(token);
      const all = [...st.artworks.values()]
        .filter((w) => w.status === status && (artist === undefined || w.artist === artist))
        .map((w) => view(w, me !== null && me === w.artist))
        .filter((w) => query.available === undefined || w.soldOut === !query.available)
        .sort((x, y) => rank(x) - rank(y) || Number(y.featured) - Number(x.featured) || (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
      const start = (page - 1) * pageSize;
      const list: ArtworkList = { items: all.slice(start, start + pageSize), page, pageSize, total: all.length };
      return list;
    },
    async getArtwork(id, token) {
      log.push('studio.getArtwork');
      const w = st.artworks.get(id);
      if (!w) return err(404, 'not_found', `No artwork ${id}`);
      if (w.status !== 'approved') {
        let sub: string | null = null;
        try {
          sub = subOf(token);
        } catch {
          sub = null;
        }
        if (sub !== w.artist) return err(404, 'not_found', `No artwork ${id}`);
      }
      if (w.status === 'reviewing' && w.needsHuman && opts.houseResolvesAfterPolls !== undefined) {
        const n = (st.polls.get(id) ?? 0) + 1;
        st.polls.set(id, n);
        if (n >= opts.houseResolvesAfterPolls) return view(decide(w, 'approve', []), tokenSub(token) === w.artist);
      }
      return view(w, tokenSub(token) === w.artist);
    },
    async createArtwork(token, req) {
      log.push('studio.createArtwork');
      const sub = subOf(token);
      if (!req.title || req.title.length > config.titleMaxChars) return err(422, 'validation_failed', `title must be 1-${config.titleMaxChars} characters`);
      if (req.description && req.description.length > config.descriptionMaxChars) return err(422, 'validation_failed', 'description is too long');
      const v = validateContentMeta({ contentType: req.contentType, contentLength: req.contentLength }, DEGENT_RULES_CONFIG);
      if (!v.ok) return err(422, 'validation_failed', v.reasons.join(' '));
      if (!validMax(req.maxEditions)) return err(422, 'validation_failed', 'maxEditions must be an integer 1-10000, or null for an open edition.');
      const id = `art_${hex.encode(sha256(enc.encode(`art|${sub}|${++seq}|${now()}`))).slice(0, 24)}`;
      const at = iso();
      const w: StudioArtwork = {
        id,
        artist: sub,
        network,
        title: req.title,
        description: req.description ?? null,
        contentType: req.contentType,
        contentLength: req.contentLength,
        contentSha256: null,
        status: 'submitted',
        needsHuman: false,
        review: null,
        featured: false,
        featuredAt: null,
        contentUrl: null,
        timeline: [{ status: 'submitted', at }],
        createdAt: at,
        updatedAt: at,
        maxEditions: req.maxEditions ?? null,
      };
      st.artworks.set(id, w);
      const uploadToken = base64url.encode(schnorr.utils.randomSecretKey()).replace(/=+$/, '');
      st.uploadTokens.set(id, uploadToken);
      return { artwork: view(w, true), uploadToken };
    },
    async uploadContent(id, uploadToken, bytes) {
      log.push('studio.uploadContent');
      const w = st.artworks.get(id);
      if (!w) return err(404, 'not_found', `No artwork ${id}`);
      if (!uploadToken) return err(401, 'unauthorized', 'Missing upload token.');
      if (st.uploadTokens.get(id) !== uploadToken) return err(403, 'forbidden', 'Wrong upload token for this artwork.');
      if (w.status !== 'submitted') return err(409, 'conflict', `Artwork ${id} already has content (${w.status}).`);
      if (bytes.length !== w.contentLength) return err(422, 'content_mismatch', `Declared ${w.contentLength} bytes, received ${bytes.length}.`);
      const sha = sha256Hex(bytes);
      st.contents.set(sha, bytes);
      const withBytes: StudioArtwork = { ...w, contentSha256: sha };
      st.artworks.set(id, withBytes);
      return view(review(withBytes, bytes), true);
    },
    async getContent(id) {
      log.push('studio.getContent');
      const w = st.artworks.get(id);
      const bytes = w?.status === 'approved' && w.contentSha256 ? st.contents.get(w.contentSha256) : undefined;
      if (!w || !bytes) return err(404, 'not_found', `No approved content for artwork ${id}`);
      return { bytes, contentType: w.contentType, sha256: w.contentSha256 };
    },
    contentUrl(id) {
      const cached = dataUrls.get(id);
      if (cached) return cached;
      const w = st.artworks.get(id);
      const bytes = w?.status === 'approved' && w.contentSha256 ? st.contents.get(w.contentSha256) : undefined;
      if (!w || !bytes) return `about:blank#${id}`;
      const url = `data:${w.contentType};base64,${base64.encode(bytes)}`;
      dataUrls.set(id, url);
      return url;
    },
    async delist(id, token) {
      log.push('studio.delist');
      const sub = subOf(token);
      const w = st.artworks.get(id);
      if (!w) return err(404, 'not_found', `No artwork ${id}`);
      if (w.artist !== sub) return err(403, 'forbidden', 'Not your artwork.');
      if (w.status !== 'approved') return err(409, 'illegal_transition', `Only approved artworks can be delisted (this one is ${w.status}).`);
      dataUrls.delete(id);
      return view(push(w, 'delisted', 'Delisted by the artist'), true);
    },
    async setEditions(id, token, maxEditions) {
      log.push('studio.setEditions');
      const sub = subOf(token);
      const w = st.artworks.get(id);
      if (!w) return err(404, 'not_found', `No artwork ${id}`);
      if (w.artist !== sub) return err(403, 'forbidden', 'Not your artwork.');
      if (w.status === 'delisted') return err(409, 'conflict', 'A delisted artwork’s edition cap cannot change.');
      if (!validMax(maxEditions) || maxEditions === undefined) return err(422, 'validation_failed', 'maxEditions must be an integer 1-10000, or null for an open edition.');
      const minted = st.royalties.filter((r) => r.artworkId === id).length;
      if (maxEditions !== null && maxEditions < minted) {
        throw new StudioApiError(409, 'conflict', `${minted} editions are already minted; the cap cannot go below that.`, { mintedEditions: minted });
      }
      const next: StudioArtwork = { ...w, maxEditions, updatedAt: iso() };
      st.artworks.set(id, next);
      return view(next, true);
    },
    async appeal(id, token, message) {
      log.push('studio.appeal');
      const sub = subOf(token);
      const w = st.artworks.get(id);
      if (!w) return err(404, 'not_found', `No artwork ${id}`);
      if (w.artist !== sub) return err(403, 'forbidden', 'Not your artwork.');
      const text = typeof message === 'string' ? message.trim() : '';
      if (text.length < 1 || text.length > 1000) return err(422, 'validation_failed', 'The appeal message must be 1-1000 characters.');
      const appeals = w.appeals ?? [];
      if (appeals.some((a) => a.status === 'open')) throw new StudioApiError(409, 'conflict', 'This artwork already has an open appeal.', { appeals: appeals.length, max: 3 });
      if (appeals.length >= 3) throw new StudioApiError(409, 'conflict', 'This artwork has used all 3 of its appeals.', { appeals: appeals.length, max: 3 });
      if (w.status !== 'rejected') return err(409, 'illegal_transition', `Only a rejected artwork can be appealed (this one is ${w.status}).`);
      const appeal: Appeal = { id: `${id}:appeal:${appeals.length + 1}`, artworkId: id, artist: sub, message: text, status: 'open', createdAt: iso(), resolvedAt: null, resolution: null };
      const withAppeal: StudioArtwork = { ...w, needsHuman: true, appeals: [...appeals, appeal] };
      st.artworks.set(id, withAppeal);
      const next = push(withAppeal, 'reviewing', 'appeal');
      return { appeal: { ...appeal }, artwork: view(next, true) };
    },
  };
  return api;
}

/** A stand-in for `@bsh/notify`'s validateWebhookTarget: https, no credentials, no localhost / private literals. */
export function fakeWebhookProblem(url: string, network: Network): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  const local = network === 'regtest';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return 'must be https';
  if (u.username || u.password) return 'must not embed credentials';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!local && (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|0\.0\.0\.0)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))) return 'must not point at a private or local address';
  return null;
}

// ------------------------------------------------------------------ bundle

export interface FakeServicesOptions {
  network?: Network;
  log?: CallLog;
  mint?: Omit<FakeMintOptions, 'network' | 'chain' | 'studio'>;
  studio?: Omit<FakeStudioOptions, 'network'>;
  wallet?: FakeWalletOptions;
  images?: FakeImageOptions | ImageTools;
  /** The block.space certificate and ord fakes (4,112 demo members by default). */
  site?: Omit<FakeSiteOptions, 'network' | 'log'>;
}

export interface FakeServices extends Services {
  site: FakeSite;
  siteState: FakeSiteState;
  studio: FakeStudio;
  log: CallLog;
  chainState: FakeChainState;
  apiOrders: Map<string, Order>;
  studioState: FakeStudioState;
}

export function createFakeServices(o: FakeServicesOptions = {}): FakeServices {
  const log = o.log ?? [];
  const network = o.network ?? 'mainnet';
  const chain = createFakeChain(log);
  const studio = createFakeStudioApi(log, { network, ...(o.studio ?? {}) });
  const mintApi = createFakeMintApi(log, { network, chain: chain.state, studio: studio.hooks, ...(o.mint ?? {}) });
  const images = o.images && 'encode' in o.images ? o.images : createFakeImages(o.images as FakeImageOptions | undefined);
  const site = createFakeSite({ network, log, ...(o.site ?? {}) });
  return {
    mode: 'demo',
    mintApi,
    studio,
    certify: site.certify,
    ord: site.ord,
    site,
    siteState: site.state,
    wallets: createFakeWallets(log, o.wallet),
    chain,
    inscription: createFakeInscription(log),
    images,
    log,
    chainState: chain.state,
    apiOrders: mintApi.orders,
    studioState: studio.state,
  };
}
