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
  ServiceConfig,
  CreateOrderRequest,
  Network,
  Order,
  OrderStatus,
  Quote,
  SubmitRevealRequest,
} from '@bsh/degent-mint-sdk';
import type {
  ChainApi,
  EncodedImage,
  FeeSnapshot,
  ImageTools,
  InscriptionContentInput,
  InscriptionOps,
  MintApi,
  QueueSnapshot,
  RescueTx,
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
        sighash: '0x83',
        contentSha256: sha256Hex(args.content.body),
      };
      return { psbtBase64: base64.encode(enc.encode(JSON.stringify(payload))) };
    },
    buildRescueReveal(args) {
      log.push('inscription.buildRescueReveal');
      const raw = sha256(enc.encode(`rescue|${args.halfSignedPsbtBase64}`));
      return { hex: hex.encode(raw), txid: hex.encode(dsha(raw).reverse()) };
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

export interface FakeMintOptions {
  network: Network;
  scenario?: FakeScenario;
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
  const auth = (id: string, token: string) => {
    if (!token) throw new Error('401 unauthorized: missing order token');
    if (tokens.get(id) !== token) throw new Error('403 forbidden: order token does not match');
  };
  const get = (id: string): Order => {
    const o = orders.get(id);
    if (!o) throw new Error(`order ${id} not found`);
    return o;
  };

  const quoteFor = (req: CreateOrderRequest): Quote => {
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
    };
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
      if (next === 'paid') txid = o.commitOutpoint?.txid;
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
    async getRescue(id, token) {
      log.push('api.getRescue');
      if (opts.rescueEndpointDown) throw new Error('service unavailable');
      auth(id, token);
      const o = get(id);
      const raw = sha256(enc.encode(`service-rescue|${id}`));
      const tx: RescueTx = { hex: hex.encode(raw), txid: hex.encode(dsha(raw).reverse()) };
      void o;
      return tx;
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

// ------------------------------------------------------------------ bundle

export interface FakeServicesOptions {
  network?: Network;
  log?: CallLog;
  mint?: Omit<FakeMintOptions, 'network' | 'chain'>;
  wallet?: FakeWalletOptions;
  images?: FakeImageOptions | ImageTools;
}

export interface FakeServices extends Services {
  log: CallLog;
  chainState: FakeChainState;
  apiOrders: Map<string, Order>;
}

export function createFakeServices(o: FakeServicesOptions = {}): FakeServices {
  const log = o.log ?? [];
  const network = o.network ?? 'mainnet';
  const chain = createFakeChain(log);
  const mintApi = createFakeMintApi(log, { network, chain: chain.state, ...(o.mint ?? {}) });
  const images = o.images && 'encode' in o.images ? o.images : createFakeImages(o.images as FakeImageOptions | undefined);
  return {
    mode: 'demo',
    mintApi,
    wallets: createFakeWallets(log, o.wallet),
    chain,
    inscription: createFakeInscription(log),
    images,
    log,
    chainState: chain.state,
    apiOrders: mintApi.orders,
  };
}
