/**
 * Fakes for every port. Used by the tests and by `?demo=1` (clearly labelled DEMO in the UI).
 *
 * They are honest where it is cheap to be: the fake wallet holds real keys and really signs the
 * funding PSBT with @scure/btc-signer, and the fake chain derives txids from the raw bytes, so the
 * funding-txid safety check runs for real. The inscription maths (commit address, reveal) is
 * simulated deterministically: it is NOT @bsh/inscription and must never touch real funds.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import type {
  ApprovalInfo,
  CreateOrderRequest,
  ExplorerQuery,
  Network,
  Order,
  OrderStatus,
  OrderSubscription,
  PublicVote,
  Quote,
  RegisterMember,
  RescueResponse,
  ServiceConfig,
  StatsResponse,
  SubmitRevealRequest,
  VoteChoice,
  VotesResponse,
} from '@bsh/degent-mint-sdk';
import { CHARTER_SIZE, GALLERY_SIZE, NOTIFY_STATUSES, voteReference, voteStatement } from '@bsh/degent-mint-sdk';
import type {
  ChainApi,
  EncodedImage,
  FeeSnapshot,
  GateApi,
  ImageTools,
  InscriptionContentInput,
  InscriptionOps,
  MintApi,
  QueueSnapshot,
  Services,
  SourceImage,
  Utxo,
  WalletId,
  WalletOption,
  WalletService,
  WalletSession,
} from './types';
import { scureNetwork } from '../lib/funding';

const enc = new TextEncoder();
const sha256Hex = (b: Uint8Array) => hex.encode(sha256(b));
const dsha = (b: Uint8Array) => sha256(sha256(b));

export type CallLog = string[];

// ------------------------------------------------------------------ config

export function demoConfig(network: Network): ServiceConfig {
  return {
    network,
    collectionAddress: fakeAddress('degent-collection', network),
    serviceFeeAddress: fakeAddress('degent-service-fee', network),
    maxUploadBytes: 4 * 1024 * 1024,
    collectionName: 'Decentralized Gentlemen Club',
    parentInscriptionId: 'a'.repeat(64) + 'i0',
    allowedContentTypes: ['image/webp', 'image/jpeg', 'image/png', 'image/avif', 'image/gif'],
    tiers: [
      {
        tier: 'standard',
        minBytes: 200_000,
        maxBytes: 390_000,
        lane: 'standard',
        label: 'Standard Degent',
        description: 'Relays through the normal mempool. Many per block.',
      },
      {
        tier: 'block',
        minBytes: 390_001,
        maxBytes: 3_900_000,
        lane: 'block',
        label: 'Block Degent',
        description: 'Fills (almost) an entire block. One per block, non-standard relay.',
      },
    ],
    maxDimensionPx: 4096,
    minDimensionPx: 500,
    postageSats: 546,
    serviceFeeSats: { standard: 25_000, block: 250_000 },
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

export function createFakeInscription(log: CallLog = []): InscriptionOps {
  return {
    generateEphemeralKey() {
      log.push('inscription.generateEphemeralKey');
      const privkey = schnorr.utils.randomSecretKey();
      return { privkey, pubkeyHex: hex.encode(schnorr.getPublicKey(privkey)) };
    },
    publicKeyHex(privkey) {
      return hex.encode(schnorr.getPublicKey(privkey));
    },
    commitAddress(pubkeyHex: string, content: InscriptionContentInput, network: Network) {
      log.push('inscription.commitAddress');
      return fakeCommitAddress(pubkeyHex, sha256Hex(content.body), content.contentType, content.parentId, network);
    },
    buildHalfSignedReveal(args) {
      log.push('inscription.buildHalfSignedReveal');
      if (args.revealPrivkey.every((b) => b === 0)) throw new Error('reveal key was wiped');
      const payload = {
        simulated: true,
        commit: args.commitOutpoint,
        commitValue: args.commitValue.toString(),
        recipient: args.recipientAddress,
        postage: args.postage.toString(),
        parentReturn: { address: args.parentReturnAddress, value: args.parentValue.toString() },
        sighash: '0x81',
        contentSha256: sha256Hex(args.content.body),
      };
      return { psbtBase64: base64.encode(enc.encode(JSON.stringify(payload))) };
    },
    buildResignedRescue(args) {
      log.push('inscription.buildResignedRescue');
      if (args.revealPrivkey.every((b) => b === 0)) throw new Error('reveal key was wiped');
      const raw = sha256(
        enc.encode(`rescue|${args.commitOutpoint.txid}:${args.commitOutpoint.vout}|${args.recipientAddress}|${sha256Hex(args.content.body)}`),
      );
      const weight = 4 * 150 + args.content.body.length;
      const vsize = Math.ceil(weight / 4);
      return { hex: hex.encode(raw), txid: hex.encode(dsha(raw).reverse()), weight, vsize, fee: args.commitValue - args.postage };
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
    async getInscriptionInfo(id) {
      log.push('chain.getInscriptionInfo');
      const seed = sha256(enc.encode(`info|${id}`));
      const c = st.contents.get(id);
      return {
        id,
        contentType: c ? 'image/webp' : 'image/webp',
        contentLength: c ? c.length : 200_000 + ((seed[0]! << 8) | seed[1]!) * 3,
        fee: 20_000 + ((seed[2]! << 8) | seed[3]!),
        height: 840_000 + ((seed[4]! << 8) | seed[5]!),
        number: 93_800_000 + ((seed[6]! << 8) | seed[7]!),
        timestamp: new Date(Date.UTC(2024, 3, 20) + ((seed[8]! << 8) | seed[9]!) * 600_000).toISOString(),
      };
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

export type FakeScenario = 'happy' | 'rescue' | 'reject' | 'declined';

/** Demo club members who vote in the fakes: their Degent numbers, in the order their votes arrive. */
export const DEMO_VOTERS = [17, 808, 2049] as const;
export const DEMO_QUORUM = 3;
/** Value of the demo parent UTXO (the parent return output the browser signs, ADR-0005). */
export const DEMO_PARENT_VALUE = 10_000;
export const DEMO_REVIEW_SLA_SECONDS = 14 * 86_400;

export interface FakeMintOptions {
  network: Network;
  scenario?: FakeScenario;
  /** Addresses that count as club members (address -> Degent numbers). Default: the demo wallets' ordinals addresses. */
  holders?: Record<string, number[]>;
  /** Seed this many strangers' orders into member_review (demo /review page). */
  seedReview?: number;
  /** Service returns a commit address that does not match the browser's (tamper test). */
  tamperCommit?: boolean;
  /** GET /rescue fails (service gone) so the front end must build the rescue locally. */
  rescueEndpointDown?: boolean;
  /** GET /rescue returns parameters that differ from the user's bundle (hostile service test). */
  tamperRescue?: boolean;
  fees?: FeeSnapshot;
  queue?: QueueSnapshot;
  chain?: FakeChainState;
  now?: () => number;
}

const PROGRESSION: Record<FakeScenario, OrderStatus[]> = {
  happy: ['paid', 'confirming', 'member_review', 'queued', 'revealing', 'revealed', 'confirmed', 'verified', 'delivered'],
  rescue: ['paid', 'confirming', 'member_review', 'queued', 'rescue_available'],
  declined: ['paid', 'confirming', 'member_review', 'declined'],
  reject: [],
};

/** Demo holders: the fake wallets' ordinals addresses (one Degent each), so `?demo=1` can sign in and vote. */
export function demoHolders(network: Network): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  WALLET_CATALOG.forEach((w, i) => {
    out[demoOrdinalsAddress(w.id, network)] = [DEMO_VOTERS[i % DEMO_VOTERS.length]! + i * 1000];
  });
  return out;
}

/** A recognisable placeholder rendering: a bowtie on lacquer, numbered. */
export function placeholderImage(label: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect width='200' height='200' fill='#0b1d15'/><path d='M100 100 L40 70 Q30 100 40 130 Z M100 100 L160 70 Q170 100 160 130 Z' fill='#c9a55a'/><rect x='88' y='88' width='24' height='24' rx='4' fill='#c9a55a'/><text x='100' y='170' font-family='monospace' font-size='18' text-anchor='middle' fill='#f1e9d4'>${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function mulberry(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic demo Gallery: 4,112 members with a size spread like the real roster (median ~372 KB). */
export function demoRoster(network: Network): RegisterMember[] {
  const rnd = mulberry(4112);
  const owners = Array.from({ length: 1400 }, (_, i) => fakeAddress(`demo-holder-${i}`, network));
  const out: RegisterMember[] = [];
  for (let n = 1; n <= GALLERY_SIZE; n++) {
    const u = rnd();
    // 85% standard (205-390 KB), 15% block-sized (390 KB - 3.96 MB)
    const kb = u < 0.85 ? 205 + rnd() * 185 : 390 + rnd() ** 2 * 3570;
    const id = `${sha256Hex(enc.encode(`degent|${n}`))}i0`;
    const whale = rnd() < 0.08;
    out.push({
      n,
      id,
      number: 93_800_000 + n * 7_000,
      via: 'gallery',
      bytes: Math.round(kb * 1024),
      height: 840_000 + n * 3,
      sat: 1_000_000_000_000 + n * 977,
      owner: owners[whale ? Math.floor(rnd() * 12) : Math.floor(rnd() * owners.length)]!,
      contentUrl: placeholderImage(`#${n}`),
    });
  }
  return out;
}

function medianOf(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function weekOf(iso: string): string {
  const d = new Date(Date.parse(iso));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export function createFakeMintApi(
  log: CallLog = [],
  opts: FakeMintOptions,
): MintApi & { orders: Map<string, Order>; votes: Map<string, PublicVote[]>; tokenFor(id: string): string | undefined; revealPsbts: Map<string, string>; subscriptions: Map<string, OrderSubscription> } {
  const config = demoConfig(opts.network);
  const orders = new Map<string, Order>();
  const bodies = new Map<string, Uint8Array>();
  const votes = new Map<string, PublicVote[]>();
  const voterAddresses = new Map<string, Set<string>>();
  const holders = opts.holders ?? demoHolders(opts.network);
  const sessions = new Map<string, string>(); // token -> address
  const roster = demoRoster(opts.network);
  let approved = 0;
  const now = opts.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const scenario = opts.scenario ?? 'happy';
  let seq = 0;

  const approvalOf = (o: Order): ApprovalInfo => {
    const vs = votes.get(o.id) ?? [];
    const started = o.timeline.find((e) => e.status === 'member_review')?.at ?? null;
    return {
      approvals: vs.filter((v) => v.vote === 'approve').length,
      declines: vs.filter((v) => v.vote === 'decline').length,
      approvalQuorum: DEMO_QUORUM,
      declineQuorum: DEMO_QUORUM,
      reviewStartedAt: started,
      reviewDeadline: started ? new Date(Date.parse(started) + DEMO_REVIEW_SLA_SECONDS * 1000).toISOString() : null,
    };
  };

  const push = (o: Order, status: OrderStatus, detail?: string, txid?: string): Order => {
    const at = iso();
    const ev: Order['timeline'][number] = { status, at };
    if (detail) ev.detail = detail;
    if (txid) ev.txid = txid;
    let next: Order = { ...o, status, updatedAt: at, timeline: [...o.timeline, ev] };
    if (status === 'member_review' || next.approval) next = { ...next, approval: approvalOf(next) };
    orders.set(o.id, next);
    return next;
  };

  const recordVote = (o: Order, degent: number, address: string, vote: VoteChoice, message: string, signature: string): Order => {
    const list = votes.get(o.id) ?? [];
    list.push({ degent, vote, at: iso(), signature, message });
    votes.set(o.id, list);
    if (!voterAddresses.has(o.id)) voterAddresses.set(o.id, new Set());
    voterAddresses.get(o.id)!.add(address);
    let cur: Order = { ...o, approval: approvalOf(o) };
    orders.set(o.id, cur);
    if (cur.approval!.approvals >= DEMO_QUORUM) {
      const degentNumber = GALLERY_SIZE + ++approved;
      cur = push({ ...cur, degentNumber, queue: { lane: o.quote?.lane ?? 'standard', position: o.quote?.queuePosition ?? 1, etaMinutes: (o.quote?.queuePosition ?? 1) * 10 } }, 'queued', `approved by ${DEMO_QUORUM} members; Degent #${degentNumber}`);
    } else if (cur.approval!.declines >= DEMO_QUORUM) {
      cur = push(cur, 'declined', `declined by ${DEMO_QUORUM} members; self-rescue (no parent) is available`);
    }
    return cur;
  };

  const seedOrder = (i: number): Order => {
    const id = `ord_demo_review_${String(i + 1).padStart(3, '0')}`;
    const bytesLen = i % 3 === 2 ? 1_900_000 : 240_000 + i * 17_000;
    const sha = sha256Hex(enc.encode(`seed|${id}`));
    const at = new Date(now() - (i + 1) * 3_600_000).toISOString();
    const req: CreateOrderRequest = {
      tier: bytesLen > 390_000 ? 'block' : 'standard',
      contentType: 'image/webp',
      contentLength: bytesLen,
      contentSha256: sha,
      recipientAddress: fakeAddress(`seed-recipient-${i}`, opts.network),
      revealPubkey: hex.encode(validXOnly(enc.encode(`seed-key-${i}`))),
      feeRate: 3,
    };
    const timeline = ['awaiting_content', 'reviewing', 'approved', 'awaiting_payment', 'paid', 'confirming', 'member_review'].map((st, k) => ({
      status: st as OrderStatus,
      at: new Date(Date.parse(at) + k * 60_000).toISOString(),
      ...(st === 'paid' ? { txid: sha256Hex(enc.encode(`seed-commit|${id}`)) } : {}),
    }));
    const o: Order = {
      id,
      network: opts.network,
      status: 'member_review',
      tier: req.tier,
      contentType: req.contentType,
      contentLength: req.contentLength,
      contentSha256: sha,
      recipientAddress: req.recipientAddress,
      revealPubkey: req.revealPubkey,
      quote: quoteFor(req),
      review: { approved: true, reasons: [], checks: [{ id: 'tuxedo', passed: true, detail: 'Tuxedo detected' }] },
      commitOutpoint: { txid: sha256Hex(enc.encode(`seed-commit|${id}`)), vout: 0 },
      revealTxid: null,
      inscriptionId: null,
      rescued: false,
      serviceFeeAddress: null,
      queue: null,
      approval: null,
      degentNumber: null,
      timeline,
      createdAt: at,
      updatedAt: timeline.at(-1)!.at,
    };
    const seeded = { ...o, approval: approvalOf(o) };
    orders.set(id, seeded);
    if (opts.chain) opts.chain.contentUrls.set(`seed:${id}`, placeholderImage(`order ${i + 1}`));
    if (i === 0) votes.set(id, [{ degent: 2049, vote: 'approve', at: seeded.updatedAt, signature: 'AA==', message: voteStatement('approve', id, sha) }]);
    return orders.get(id)!;
  };

  const requests = new Map<string, CreateOrderRequest>();
  const tokens = new Map<string, string>();
  const revealPsbts = new Map<string, string>();
  const subscriptions = new Map<string, OrderSubscription>();
  const auth = (id: string, token: string) => {
    if (!token) throw new Error('401 unauthorized: missing order token');
    if (tokens.get(id) !== token) throw new Error('403 forbidden: order token does not match');
  };
  const get = (id: string): Order => {
    const o = orders.get(id);
    if (!o) throw new Error(`order ${id} not found`);
    return o;
  };

  // Hoisted: seedOrder() above needs it.
  function quoteFor(req: CreateOrderRequest): Quote {
    const tierRule = config.tiers.find((t) => t.tier === req.tier)!;
    // Simulated weight: witness bytes weigh 1 WU; ~1,300 WU of non-witness overhead with parent.
    const chunks = Math.ceil(req.contentLength / 520);
    const revealWeight = req.contentLength + chunks * 2 + 1_300 + req.contentType.length;
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
    return {
      tier: req.tier,
      lane: tierRule.lane,
      feeRate: req.feeRate,
      revealWeight,
      revealVsize,
      revealFeeSats,
      postageSats: config.postageSats,
      serviceFeeSats,
      commitValueSats,
      totalSats: commitValueSats + serviceFeeSats,
      commitAddress: opts.tamperCommit ? fakeAddress('attacker-commit', opts.network) : commitAddress,
      binding: true,
      expiresAt: new Date(now() + config.quoteTtlSeconds * 1000).toISOString(),
      queuePosition: req.tier === 'block' ? queue.blockLaneLength + 1 : null,
      etaMinutes: req.tier === 'block' ? (queue.blockLaneLength + 1) * 10 : 10,
      parentReturnAddress: config.collectionAddress,
      parentValueSats: DEMO_PARENT_VALUE,
    };
  }

  for (let i = 0; i < (opts.seedReview ?? 0); i++) seedOrder(i);

  const sessionAddress = (token: string): string => {
    const a = sessions.get(token);
    if (!a) throw new Error('401 unauthorized: holder session missing or expired');
    if (!(holders[a]?.length ?? 0)) throw new Error('403 not_a_holder: this address no longer holds a Degent');
    return a;
  };

  const members = (): RegisterMember[] => {
    const children: RegisterMember[] = [];
    for (const o of orders.values())
      if (o.status === 'delivered' && o.degentNumber !== null && o.inscriptionId && !o.rescued)
        children.push({ n: o.degentNumber, id: o.inscriptionId, number: null, via: 'child', bytes: o.contentLength, height: 912_345, sat: null, owner: o.recipientAddress, contentUrl: opts.chain?.contentUrls.get(o.inscriptionId) ?? placeholderImage(`#${o.degentNumber}`) });
    return [...roster, ...children];
  };

  return {
    orders,
    votes,
    tokenFor: (id: string) => tokens.get(id),
    revealPsbts,
    subscriptions,
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
    async createOrder(req) {
      log.push('api.createOrder');
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
        approval: null,
        degentNumber: null,
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
      revealPsbts.set(id, req.halfSignedRevealPsbt);
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
      // Member review: seeded orders wait for real votes; the user's own order gets one demo vote per poll.
      if (o.status === 'member_review') {
        if (o.id.startsWith('ord_demo_review_')) return o;
        const cast = (votes.get(o.id) ?? []).length;
        const degent = DEMO_VOTERS[cast % DEMO_VOTERS.length]!;
        const choice: VoteChoice = scenario === 'declined' ? 'decline' : 'approve';
        return recordVote(o, degent, `demo-member-${degent}`, choice, voteStatement(choice, o.id, voteReference(o)), base64.encode(sha256(enc.encode(`demo-vote|${o.id}|${degent}`))));
      }
      let cur = o;
      let txid: string | undefined;
      if (next === 'paid') txid = o.commitOutpoint?.txid;
      if (next === 'member_review') txid = o.commitOutpoint?.txid;
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
    async subscribeOrder(id, token, req) {
      log.push(`api.subscribeOrder:${req.channel}`);
      auth(id, token);
      const o = get(id);
      if (['rejected', 'delivered', 'failed'].includes(o.status)) throw new Error(`409 conflict: order is ${o.status}; nothing left to notify`);
      const valid = req.channel === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.address) : /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(req.address);
      if (!valid) throw new Error(`422 validation_failed: invalid ${req.channel === 'email' ? 'email address' : 'telegram chat id'}`);
      const sub: OrderSubscription = {
        id: `sub_${sha256Hex(enc.encode(`${id}|${req.channel}|${req.address.toLowerCase()}`)).slice(0, 24)}`,
        orderId: id,
        channel: req.channel,
        address: req.address,
        events: [...NOTIFY_STATUSES],
        createdAt: iso(),
      };
      subscriptions.set(sub.id, sub);
      return sub;
    },
    async getRescue(id, token) {
      log.push('api.getRescue');
      if (opts.rescueEndpointDown) throw new Error('service unavailable');
      auth(id, token);
      // The real service refuses outside rescue_available / declined; the fake stays lenient for effect tests.
      const o = get(id);
      const body = bodies.get(id);
      if (!o.quote || !o.commitOutpoint || !body) throw new Error('409 rescue_unavailable');
      const weight = 4 * 150 + body.length;
      const params: RescueResponse = {
        orderId: id,
        network: o.network,
        method: 'resign',
        commitOutpoint: o.commitOutpoint,
        commitValueSats: o.quote.commitValueSats,
        recipientAddress: o.recipientAddress,
        postageSats: o.quote.postageSats,
        contentType: o.contentType,
        contentSha256: o.contentSha256,
        contentBase64: base64.encode(body),
        parentInscriptionId: config.parentInscriptionId,
        revealPubkey: o.revealPubkey,
        feeRate: o.quote.feeRate,
        weight,
        vsize: Math.ceil(weight / 4),
        feeSats: o.quote.commitValueSats - o.quote.postageSats,
      };
      return opts.tamperRescue ? { ...params, recipientAddress: fakeAddress('attacker-rescue', opts.network) } : params;
    },

    // ------------------------------------------------------------ member approval
    async authChallenge(address) {
      log.push('api.authChallenge');
      const at = iso();
      const exp = new Date(now() + 300_000).toISOString();
      const message = [
        'degent.club wants you to sign in with your Bitcoin account:',
        address,
        '',
        'Sign in to degent.club as a club member. This request will not trigger a transaction or cost any fees.',
        '',
        'URI: https://degent.club',
        'Version: 1',
        `Network: ${opts.network}`,
        `Nonce: ${sha256Hex(enc.encode(`nonce|${address}|${at}`)).slice(0, 32)}`,
        `Issued At: ${at}`,
        `Expiration Time: ${exp}`,
      ].join('\n');
      return { message, expiresAt: exp };
    },
    async authVerify(address, message, signature) {
      log.push('api.authVerify');
      if (!message.includes(address) || !signature) throw new Error('401 auth_failed: invalid_signature');
      const degents = holders[address] ?? [];
      if (!degents.length) throw new Error('403 not_a_holder: this address holds no Degent; only club members can review');
      const token = `demo.${hex.encode(sha256(enc.encode(`session|${address}|${now()}`)))}.sig`;
      sessions.set(token, address);
      return { token, address, degents, expiresAt: new Date(now() + 3_600_000).toISOString() };
    },
    async getReviewQueue(token) {
      log.push('api.getReviewQueue');
      const address = sessionAddress(token);
      const items = [...orders.values()]
        .filter((o) => o.status === 'member_review')
        .map((o) => ({ order: { ...o, approval: approvalOf(o) }, approval: approvalOf(o), voted: (voterAddresses.get(o.id)?.has(address) ? (votes.get(o.id) ?? []).at(-1)?.vote ?? null : null) as VoteChoice | null }));
      return { items, memberDegents: holders[address] ?? [] };
    },
    async castVote(id, token, req) {
      log.push(`api.castVote:${req.vote}`);
      const address = sessionAddress(token);
      const o = get(id);
      if (o.status !== 'member_review') throw new Error(`409 review_closed: order is not open for member review (status ${o.status})`);
      if (o.recipientAddress === address) throw new Error('403 self_vote: a member cannot vote on their own order');
      if (voterAddresses.get(id)?.has(address)) throw new Error('409 already_voted: this address has already voted on this order');
      if (req.message !== voteStatement(req.vote, o.id, voteReference(o))) throw new Error('422 vote_invalid: message is not the expected statement');
      if (!req.signature) throw new Error('422 vote_invalid: signature missing');
      const degent = Math.min(...(holders[address] ?? [0]));
      const cur = recordVote(o, degent, address, req.vote, req.message, req.signature);
      return { orderId: id, status: cur.status, approval: approvalOf(cur), votes: votes.get(id) ?? [] };
    },
    async getVotes(id): Promise<VotesResponse> {
      log.push('api.getVotes');
      const o = get(id);
      return { orderId: id, status: o.status, approval: approvalOf(o), votes: votes.get(id) ?? [] };
    },

    // ------------------------------------------------------------ the Register
    async getRegister() {
      log.push('api.getRegister');
      const all = members();
      return { parent: config.parentInscriptionId, gallery: null, count: all.length, bytes: all.reduce((a, m) => a + m.bytes, 0), pending: [...orders.values()].filter((o) => o.degentNumber !== null && o.status !== 'delivered').length, updatedAt: iso() };
    },
    async getRegisterMember(n) {
      log.push('api.getRegisterMember');
      const m = members().find((x) => x.n === n);
      if (!m) throw new Error('404 not_found: Degent not found');
      return m;
    },
    async getHolder(address) {
      log.push('api.getHolder');
      const degents = holders[address] ?? members().filter((m) => m.owner === address).map((m) => m.n);
      return { address, holder: degents.length > 0, degents };
    },
    async verifyMember(id) {
      log.push('api.verifyMember');
      const m = members().find((x) => x.id === id);
      return m ? { id, member: true, via: m.via, n: m.n } : { id, member: false, via: null, n: null };
    },
    async getExplorer(q: ExplorerQuery) {
      log.push('api.getExplorer');
      const offset = q.offset ?? 0;
      const limit = q.limit ?? 48;
      const sort = q.sort ?? 'n';
      const order = q.order ?? 'asc';
      const text = (q.q ?? '').trim().toLowerCase();
      const key = (m: RegisterMember) => (sort === 'bytes' ? m.bytes : sort === 'height' ? (m.height ?? m.number ?? m.n) : m.n);
      const rule = q.tier ? config.tiers.find((t) => t.tier === q.tier) : undefined;
      const lo = Math.max(q.minBytes ?? 0, rule?.minBytes ?? 0);
      const hi = Math.min(q.maxBytes ?? Number.MAX_SAFE_INTEGER, rule?.maxBytes ?? Number.MAX_SAFE_INTEGER);
      const filtered = members().filter((m) => {
        if (m.bytes < lo || m.bytes > hi) return false;
        if (!text) return true;
        if (/^#?\d+$/.test(text)) return m.n === Number(text.replace('#', ''));
        return m.id.startsWith(text) || (m.owner?.toLowerCase().startsWith(text) ?? false);
      });
      const sorted = [...filtered].sort((a, b) => (order === 'desc' ? -1 : 1) * (key(a) - key(b)) || a.n - b.n);
      return { items: sorted.slice(offset, offset + limit), total: filtered.length, offset, limit, sort, order };
    },
    async getStats(): Promise<StatsResponse> {
      log.push('api.getStats');
      const all = members();
      const bytes = all.map((m) => m.bytes);
      const edges = [0, 200, 250, 300, 350, 390, 500, 1000, 2000, 3000, 4000];
      const sizeHistogram = edges.map((from, i) => ({ from, to: i + 1 < edges.length ? edges[i + 1]! : null, count: 0 }));
      for (const b of bytes) {
        const kb = b / 1024;
        const idx = sizeHistogram.findIndex((x) => x.to === null || kb < x.to);
        sizeHistogram[idx]!.count++;
      }
      const weeks = new Map<string, number>();
      for (const m of all) {
        const week = weekOf(new Date(Date.UTC(2024, 3, 20) + (m.height! - 840_000) * 600_000).toISOString());
        weeks.set(week, (weeks.get(week) ?? 0) + 1);
      }
      const counts = new Map<string, number>();
      for (const m of all) if (m.owner) counts.set(m.owner, (counts.get(m.owner) ?? 0) + 1);
      const list = [...orders.values()];
      return {
        minted: all.length,
        charter: CHARTER_SIZE,
        totalBytes: bytes.reduce((a, b) => a + b, 0),
        medianBytes: medianOf(bytes),
        mintsPerWeek: [...weeks.entries()].sort().map(([week, count]) => ({ week, count })),
        sizeHistogram,
        approvals: {
          inReview: list.filter((o) => o.status === 'member_review').length,
          approved: list.filter((o) => o.degentNumber !== null).length,
          declined: list.filter((o) => o.status === 'declined').length,
          perWeek: [],
          medianSecondsToQuorum: null,
        },
        topHolders: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([owner, count]) => ({ owner, count })),
        updatedAt: iso(),
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

/** The ordinals address the fake wallet `id` reports (same derivation as connect()). */
export function demoOrdinalsAddress(id: WalletId, network: Network): string {
  const ordX = schnorr.getPublicKey(sha256(enc.encode(`demo-ord|${id}`)));
  return btc.p2tr(ordX, undefined, scureNetwork(network)).address!;
}

export interface FakeWalletOptions {
  installed?: WalletId[];
  /** signMessage rejects (user declined). */
  rejectSignMessage?: boolean;
  /** Payment address type the wallet reports. */
  paymentType?: 'p2wpkh' | 'p2sh-p2wpkh' | 'p2tr' | 'p2pkh';
  /** Wallet mutates the transaction before signing (should be caught by the txid check). */
  tamper?: boolean;
  rejectSign?: boolean;
  withPushTx?: boolean;
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
          for (const { index } of req.inputsToSign) tx.signIdx(payPriv, index);
          if (req.finalize) tx.finalize();
          return { psbtBase64: base64.encode(tx.toPSBT()) };
        },
        async signMessage(message, address) {
          log.push('wallet.signMessage');
          if (opts.rejectSignMessage) throw new Error('User rejected the request.');
          // Simulated BIP-322: deterministic and unforgeable enough for the fakes (the real wallet signs with its key).
          return base64.encode(sha256(enc.encode(`bip322|${address}|${message}|${hex.encode(ordPriv)}`)));
        },
        async disconnect() {
          log.push('wallet.disconnect');
        },
      };
      if (opts.withPushTx) {
        session.pushTx = async (txHex: string) => {
          log.push('wallet.pushTx');
          return btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true }).id;
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
  log?: CallLog;
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
  const log = opts.log;
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
    async compose(_src, layout) {
      log?.push('images.compose');
      // Size ~ fullSize x (0.08 + 0.92 q) x (edge / source edge)^2, with a JPEG header so sniffing sees a JPEG.
      const scale = layout.size / Math.max(width, height);
      return {
        width: layout.size,
        height: layout.size,
        async toBlob(_type, quality) {
          const size = fakeEncodedSize(fullSize, quality, scale);
          const bytes = bytesOfSize(size, `jpeg|${quality}|${layout.size}|${layout.frame}|${layout.text}`);
          bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1], 0);
          return new Blob([bytes.slice()], { type: 'image/jpeg' });
        },
      };
    },
    async template() {
      return { width, height, handle: null };
    },
    async sample() {
      return new Blob([bytesOfSize(fullSize, 'sample').slice()], { type: 'image/webp' });
    },
  };
}

// ------------------------------------------------------------------ telegram gate

export interface FakeGateOptions {
  /** Reject every verification with this message. */
  reject?: string;
}

/** A SIWB-shaped challenge like the real gate's (the fake wallet signs any text). */
export function fakeGateChallenge(token: string, address: string, telegramUserId = 777): string {
  return [
    'degent.club wants you to sign in with your Bitcoin account:',
    address,
    '',
    `Prove I hold a Degent to join the degent.club holders group as Telegram user ${telegramUserId}. No transaction, no fees.`,
    '',
    'URI: https://degent.club',
    'Version: 1',
    'Network: mainnet',
    `Nonce: ${token.replace(/[^A-Za-z0-9]/g, '').padEnd(16, '0').slice(0, 32)}`,
    'Issued At: 2026-09-24T12:00:00.000Z',
    'Expiration Time: 2026-09-24T12:10:00.000Z',
  ].join('\n');
}

export function createFakeGate(log: CallLog = [], opts: FakeGateOptions = {}): GateApi & { submissions: Array<{ url: string; body: unknown }> } {
  const submissions: Array<{ url: string; body: unknown }> = [];
  return {
    submissions,
    async challenge(url, body) {
      log.push('gate.challenge');
      submissions.push({ url: `${url}/gate/challenge`, body });
      return { ok: true, message: fakeGateChallenge(body.token, body.address), expiresAt: '2026-09-24T12:10:00.000Z' };
    },
    async submit(url, body) {
      log.push('gate.submit');
      submissions.push({ url: `${url}/gate/verify`, body });
      if (opts.reject) return { ok: false, message: opts.reject };
      return { ok: true, degents: [17], message: 'Verified. Your single-use invite is in your Telegram DMs.' };
    },
  };
}

// ------------------------------------------------------------------ bundle

export interface FakeServicesOptions {
  network?: Network;
  log?: CallLog;
  mint?: Omit<FakeMintOptions, 'network' | 'chain'>;
  wallet?: FakeWalletOptions;
  images?: FakeImageOptions | ImageTools;
  gate?: FakeGateOptions;
}

export interface FakeServices extends Services {
  log: CallLog;
  chainState: FakeChainState;
  apiOrders: Map<string, Order>;
  apiVotes: Map<string, PublicVote[]>;
  gateSubmissions: Array<{ url: string; body: unknown }>;
  /** The most recent half-signed reveal the fake mint received. */
  lastRevealPsbt(): string | undefined;
}

export function createFakeServices(o: FakeServicesOptions = {}): FakeServices {
  const log = o.log ?? [];
  const network = o.network ?? 'mainnet';
  const chain = createFakeChain(log);
  const mintApi = createFakeMintApi(log, { network, chain: chain.state, ...(o.mint ?? {}) });
  const images = o.images && 'encode' in o.images ? o.images : createFakeImages({ log, ...(o.images as FakeImageOptions | undefined) });
  const gate = createFakeGate(log, o.gate);
  return {
    mode: 'demo',
    mintApi,
    wallets: createFakeWallets(log, o.wallet),
    chain,
    inscription: createFakeInscription(log),
    images,
    gate,
    log,
    chainState: chain.state,
    apiOrders: mintApi.orders,
    apiVotes: mintApi.votes,
    gateSubmissions: gate.submissions,
    lastRevealPsbt: () => [...mintApi.revealPsbts.values()].at(-1),
  };
}
