/**
 * Test harness: the full service (API + worker) on in-memory adapters, a fake regtest chain,
 * fake clock and capturing broadcasters. Also a "browser" that does exactly what the front end
 * does: ephemeral key, create order, upload bytes, build the half-signed reveal, submit it.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { p2tr, p2wpkh } from '@scure/btc-signer';
import { addressToScript, buildHalfSignedReveal, buildResignedRescue, commitAddress, networkParams, type Attribution } from '@bsh/inscription';
import type { CreateOrderResponse, Order, RescueInputs, Tier } from '@bsh/degent-mint-sdk';
import { DEFAULT_CLUB_FEE_BPS, DEFAULT_CONFIG, DEFAULT_ROYALTY_BPS, MAX_UPLOAD_BYTES, sha256Hex, tierForSize } from '@bsh/degent-mint-sdk';
import { MetaEditionStore } from '../../src/adapters/edition-store.js';
import { MemoryLedgerClient } from '../../src/adapters/ledger-client.js';
import { MemoryStudioClient } from '../../src/adapters/studio-client.js';
import { ATTRIBUTION_STUDIO } from '../../src/domain/quote.js';
import { createApp } from '../../src/app.js';
import { OrderService } from '../../src/application/order-service.js';
import type { MintSettings } from '../../src/application/settings.js';
import { MemoryOrderStore } from '../../src/adapters/memory-order-store.js';
import { MemoryContentStore } from '../../src/adapters/content-stores.js';
import { EncryptedRevealVault, MemorySecretBlobStore } from '../../src/adapters/reveal-vault.js';
import { InMemoryPolicySigner } from '../../src/adapters/in-memory-policy-signer.js';
import { StoreParentUtxoProvider } from '../../src/adapters/store-parent-utxo.js';
import { RulesArtReview } from '../../src/adapters/rules-art-review.js';
import { StaticFees } from '../../src/adapters/fees.js';
import { MemoryEventBus } from '../../src/adapters/system.js';
import { DEFAULT_POLICY } from '../../src/domain/policy.js';
import { MintWorker } from '../../src/worker.js';
import type { ArtReview } from '../../src/ports/art-review.js';
import { FakeChain } from './chain.js';
import { FakeArtReview, FakeBroadcaster, FakeClock } from './misc.js';
import { png } from './images.js';

export const NET = 'regtest' as const;
export const TEST_KEY = '11'.repeat(32);
export const PARENT_KEY = new Uint8Array(32).fill(7);

export function regtestAddress(seed: number): string {
  const key = new Uint8Array(32).fill(seed);
  return p2tr(schnorr.getPublicKey(key), undefined, networkParams(NET)).address!;
}

/** A P2WPKH regtest address (the other payout script type the studio accepts). */
export function regtestWpkhAddress(seed: number): string {
  const key = new Uint8Array(32).fill(seed);
  return p2wpkh(new Uint8Array([0x02, ...schnorr.getPublicKey(key)]), networkParams(NET)).address!;
}

export function fakeTxid(n: number): string {
  return sha256Hex(new TextEncoder().encode(`fake-tx-${n}`));
}

export interface HarnessOptions {
  review?: ArtReview;
  corsOrigins?: string[];
  rateLimit?: { windowMs: number; max: number };
  settings?: Partial<MintSettings>;
  parentValue?: bigint;
  /** Open Studio fakes; default: an empty MemoryStudioClient and a MemoryLedgerClient. `studio: null` disables artwork orders. */
  studio?: MemoryStudioClient | null;
  ledger?: MemoryLedgerClient | null;
}

export function makeHarness(opts: HarnessOptions = {}) {
  const clock = new FakeClock();
  const chain = new FakeChain(NET);
  const policy = structuredClone(DEFAULT_POLICY);
  const signer = new InMemoryPolicySigner(PARENT_KEY, NET, policy, { warn: () => {} });
  const collectionAddress = signer.collectionAddress();
  const collectionScriptHex = bytesToHex(addressToScript(collectionAddress, NET));

  // The parent inscription's current UTXO, held by the collection key.
  const parentTxid = fakeTxid(0);
  const parentValue = opts.parentValue ?? 10_000n;
  chain.addTx({ txid: parentTxid, vin: [], vout: [{ value: parentValue, scriptHex: collectionScriptHex }], confirmed: true });

  const settings: MintSettings = {
    network: NET,
    version: 'test',
    collection: { ...structuredClone(DEFAULT_CONFIG), network: NET, parentInscriptionId: `${parentTxid}i0` },
    collectionAddress,
    parentValueSats: Number(parentValue),
    serviceFeeAddress: null,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    standardConcurrency: 3,
    confirmations: 1,
    latePaymentWindowSeconds: 86_400,
    policy,
    royaltyBps: DEFAULT_ROYALTY_BPS,
    clubFeeBps: { standard: DEFAULT_CLUB_FEE_BPS, large: DEFAULT_CLUB_FEE_BPS, fullblock: DEFAULT_CLUB_FEE_BPS },
    studioUrl: 'http://studio.test',
    ...opts.settings,
  };
  const store = new MemoryOrderStore();
  const content = new MemoryContentStore();
  const blobs = new MemorySecretBlobStore();
  const reveals = new EncryptedRevealVault(blobs, TEST_KEY);
  const events = new MemoryEventBus();
  const review = opts.review ?? new RulesArtReview(settings.collection);
  const studio = opts.studio === null ? undefined : (opts.studio ?? new MemoryStudioClient());
  const ledger = opts.ledger === null ? undefined : (opts.ledger ?? new MemoryLedgerClient());
  const editions = new MetaEditionStore(store);
  let n = 0;
  const fees = new StaticFees({ standard: { slow: 1, normal: 2, fast: 5 }, block: { min: 1, recommended: 3 } }, () => clock.now());
  const orders = new OrderService({
    settings,
    store,
    content,
    reveals,
    review,
    events,
    clock,
    chain,
    fees,
    editions,
    studio,
    ledger,
    newId: () => `dgt_test${String(++n).padStart(4, '0')}`,
  });
  const parents = new StoreParentUtxoProvider(store);
  const ready = parents.initialise({
    txid: parentTxid,
    vout: 0,
    value: parentValue,
    scriptHex: collectionScriptHex,
    confirmed: true,
    createdByLane: null,
  });
  const app = createApp({
    orders,
    fees,
    chain,
    parents,
    clock,
    corsOrigins: opts.corsOrigins ?? ['https://degent.club'],
    rateLimit: opts.rateLimit ?? { windowMs: 60_000, max: 10_000 },
    clientIp: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
  });
  const broadcasters = { standard: new FakeBroadcaster('standard', chain), block: new FakeBroadcaster('block', chain) };
  const worker = new MintWorker({ orders, store, content, reveals, chain, parents, signer, broadcasters, clock });

  return { clock, chain, signer, settings, store, content, blobs, reveals, events, orders, parents, app, broadcasters, worker, ready, collectionScriptHex, parentTxid, parentValue, studio, ledger, editions };
}

export type Harness = ReturnType<typeof makeHarness>;

// ----------------------------------------------------------------------------- HTTP helpers

export async function api(h: Harness, method: string, path: string, init: { json?: unknown; bytes?: Uint8Array; token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(init.json);
  }
  if (init.bytes) {
    headers['content-type'] ??= 'application/octet-stream';
    body = init.bytes as unknown as BodyInit;
  }
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await h.app.request(path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

// ----------------------------------------------------------------------------- the "browser"

export interface BrowserMint {
  revealKey: Uint8Array;
  revealPubkey: string;
  bytes: Uint8Array;
  contentType: string;
  recipientAddress: string;
  orderId: string;
  token: string;
  order: Order;
  commitTxid?: string;
  psbt?: string;
  /** Open Studio: the attribution the browser signs into the envelope (from the quote). */
  attribution?: Attribution;
}

/** What the web app builds the envelope with for an artwork order: exactly the quote's facts (plan §3.4). */
export function attributionFromQuote(order: Order): Attribution {
  const q = order.quote!;
  return { artist: q.artistAddress!, artwork: q.artworkId!, edition: q.edition!, studio: ATTRIBUTION_STUDIO };
}

export function standardArt(size = 200_000, w = 1024, h = 1024): Uint8Array {
  return png(w, h, size);
}

/** ~1.2M WU reveal: a Large Degent (ADR-0005 §4 test size). */
export function largeArt(seed: number, size = 1_195_000): Uint8Array {
  return png(1000 + seed, 1000, size);
}

/** A Full Block Degent (>= 3.5 MB of content). */
export function fullBlockArt(seed: number, size = 3_500_000): Uint8Array {
  return png(1000 + seed, 1000, size);
}

export async function browserCreate(
  h: Harness,
  o: { bytes?: Uint8Array; contentType?: string; tier?: Tier; feeRate?: number; recipientSeed?: number } = {},
): Promise<BrowserMint> {
  const bytes = o.bytes ?? standardArt();
  const contentType = o.contentType ?? 'image/png';
  const revealKey = schnorr.utils.randomSecretKey();
  const revealPubkey = bytesToHex(schnorr.getPublicKey(revealKey));
  const recipientAddress = regtestAddress(o.recipientSeed ?? 42);
  const res = await api(h, 'POST', '/v1/orders', {
    json: {
      tier: o.tier ?? tierForSize(bytes.length)?.tier ?? 'standard',
      contentType,
      contentLength: bytes.length,
      contentSha256: sha256Hex(bytes),
      recipientAddress,
      revealPubkey,
      feeRate: o.feeRate ?? 2,
    },
  });
  if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
  const created = res.body as CreateOrderResponse;
  return { revealKey, revealPubkey, bytes, contentType, recipientAddress, orderId: created.order.id, token: created.orderToken, order: created.order };
}

export async function browserUpload(h: Harness, b: BrowserMint): Promise<Order> {
  const res = await api(h, 'PUT', `/v1/orders/${b.orderId}/content`, { bytes: b.bytes, token: b.token });
  if (res.status !== 200) throw new Error(`upload failed: ${JSON.stringify(res.body)}`);
  b.order = res.body as Order;
  return b.order;
}

/**
 * Builds the half-signed reveal exactly as the browser does (ADR-0005 §1: SIGHASH_ALL|ANYONECANPAY
 * over [parent return, child], parent return = collection address + constant parent value from
 * GET /v1/config), then submits it.
 */
export async function browserReveal(
  h: Harness,
  b: BrowserMint,
  commitTxid = fakeTxid(1000 + Math.floor(Math.random() * 1e6)),
  override: Partial<Parameters<typeof buildHalfSignedReveal>[0]> = {},
) {
  const quote = b.order.quote!;
  const content = { contentType: b.contentType, body: b.bytes, parentId: h.settings.collection.parentInscriptionId!, ...(b.attribution ? { attribution: b.attribution } : {}) };
  const commit = commitAddress(schnorr.getPublicKey(b.revealKey), content, NET);
  if (commit.address !== quote.commitAddress) throw new Error('browser and service disagree on the commit address');
  const cfg = (await api(h, 'GET', '/v1/config')).body as { collectionAddress: string; parentValueSats: number };
  const { psbtBase64 } = buildHalfSignedReveal({
    network: NET,
    revealPrivkey: b.revealKey,
    content,
    commitOutpoint: { txid: commitTxid, vout: 0 },
    commitValue: BigInt(quote.commitValueSats),
    recipientAddress: b.recipientAddress,
    postage: BigInt(quote.postageSats),
    parentReturnAddress: cfg.collectionAddress,
    parentValue: BigInt(cfg.parentValueSats),
    ...override,
  });
  b.commitTxid = commitTxid;
  b.psbt = psbtBase64;
  const res = await api(h, 'POST', `/v1/orders/${b.orderId}/reveal`, {
    json: { commitTxid, commitVout: 0, halfSignedRevealPsbt: psbtBase64, commitAddress: commit.address },
    token: b.token,
  });
  return res;
}

/**
 * Self-rescue as the browser does it (ADR-0005 §2): GET /rescue for the inputs, re-sign
 * [commit] -> [child] with K_e from the recovery bundle, broadcast it (here: straight into the chain).
 */
export async function browserRescue(h: Harness, b: BrowserMint) {
  const res = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
  if (res.status !== 200) throw new Error(`rescue inputs failed: ${JSON.stringify(res.body)}`);
  const inputs = res.body as RescueInputs;
  if (inputs.contentSha256 !== sha256Hex(b.bytes)) throw new Error('rescue inputs are for other content');
  // Recovery bundle v2 carries artworkId and the reserved edition; the rescue must reproduce the same envelope (§3.6).
  const attribution: Attribution | undefined = inputs.artworkId
    ? { artist: inputs.artistAddress!, artwork: inputs.artworkId, edition: inputs.edition!, studio: ATTRIBUTION_STUDIO }
    : undefined;
  if (b.attribution && JSON.stringify(attribution) !== JSON.stringify(b.attribution)) throw new Error('rescue inputs disagree with the bundle attribution');
  const rescue = buildResignedRescue({
    network: NET,
    revealPrivkey: b.revealKey,
    content: { contentType: inputs.contentType, body: b.bytes, ...(inputs.parentInscriptionId ? { parentId: inputs.parentInscriptionId } : {}), ...(attribution ? { attribution } : {}) },
    commitOutpoint: { txid: inputs.commitTxid, vout: inputs.commitVout },
    commitValue: BigInt(inputs.commitValueSats),
    recipientAddress: inputs.recipientAddress,
    postage: BigInt(inputs.postageSats),
  });
  const txid = h.chain.acceptRaw(rescue.hex);
  return { inputs, rescue, txid };
}

/** The user's wallet broadcasts the funding tx paying the commit address. */
export function fundCommit(h: Harness, b: BrowserMint, opts: { value?: bigint; confirmed?: boolean } = {}): void {
  const quote = b.order.quote!;
  h.chain.addTx({
    txid: b.commitTxid!,
    vin: [{ txid: fakeTxid(999_999), vout: 0 }],
    vout: [{ value: opts.value ?? BigInt(quote.commitValueSats), scriptHex: bytesToHex(addressToScript(quote.commitAddress!, NET)) }],
    confirmed: opts.confirmed ?? false,
  });
}

/** Everything up to awaiting_payment. */
export async function browserMintToPayment(h: Harness, o: Parameters<typeof browserCreate>[1] = {}): Promise<BrowserMint> {
  await h.ready;
  const b = await browserCreate(h, o);
  await browserUpload(h, b);
  const r = await browserReveal(h, b);
  if (r.status !== 200) throw new Error(`reveal failed: ${JSON.stringify(r.body)}`);
  b.order = r.body as Order;
  return b;
}

// ----------------------------------------------------------------------------- Open Studio artwork orders

export interface StudioArtworkOptions {
  id?: string;
  bytes?: Uint8Array;
  contentType?: string;
  /** Artist identity address seed (P2TR). */
  artistSeed?: number;
  /** Payout address: a P2TR (default, seed 60 + artistSeed) or explicit. `null` = not proven. */
  payoutAddress?: string | null;
  status?: 'submitted' | 'reviewing' | 'approved' | 'rejected' | 'delisted';
}

let artworkN = 0;

/** Hang an artwork in the fake studio (approved, artist with a proven P2TR payout address by default). */
export function studioArtwork(h: Harness, o: StudioArtworkOptions = {}) {
  if (!h.studio) throw new Error('harness has no studio');
  const artistSeed = o.artistSeed ?? 1;
  const payoutAddress = o.payoutAddress === undefined ? regtestAddress(60 + artistSeed) : o.payoutAddress;
  const art = h.studio.addArtwork({
    id: o.id ?? `art_test${String(++artworkN).padStart(3, '0')}`,
    artist: regtestAddress(30 + artistSeed),
    payoutAddress,
    bytes: o.bytes ?? standardArt(200_000, 1024, 1024),
    contentType: o.contentType ?? 'image/png',
    ...(o.status ? { status: o.status } : {}),
  });
  return art;
}

/** POST /v1/orders with artworkId, as the web app does after fetching the artwork record from the studio. */
export async function browserCreateArtwork(
  h: Harness,
  artworkId: string,
  o: { feeRate?: number; recipientSeed?: number; tier?: Tier; facts?: Partial<{ contentType: string; contentLength: number; contentSha256: string }> } = {},
) {
  const art = h.studio?.artworks.get(artworkId);
  const revealKey = schnorr.utils.randomSecretKey();
  const revealPubkey = bytesToHex(schnorr.getPublicKey(revealKey));
  const recipientAddress = regtestAddress(o.recipientSeed ?? 42);
  const facts = {
    contentType: art?.contentType ?? 'image/png',
    contentLength: art?.contentLength ?? 200_000,
    contentSha256: art?.contentSha256 ?? 'a'.repeat(64),
    ...(o.facts ?? {}),
  };
  const res = await api(h, 'POST', '/v1/orders', {
    json: {
      tier: o.tier ?? tierForSize(facts.contentLength)?.tier ?? 'standard',
      ...facts,
      recipientAddress,
      revealPubkey,
      feeRate: o.feeRate ?? 2,
      artworkId,
    },
  });
  const b: BrowserMint | null =
    res.status === 201
      ? {
          revealKey,
          revealPubkey,
          bytes: art!.bytes!,
          contentType: art!.contentType,
          recipientAddress,
          orderId: (res.body as CreateOrderResponse).order.id,
          token: (res.body as CreateOrderResponse).orderToken,
          order: (res.body as CreateOrderResponse).order,
          attribution: attributionFromQuote((res.body as CreateOrderResponse).order),
        }
      : null;
  return { res, b };
}

/** Artwork order up to awaiting_payment (create is already `approved`, then the half-signed reveal). */
export async function browserArtworkToPayment(h: Harness, artworkId: string, o: Parameters<typeof browserCreateArtwork>[2] = {}): Promise<BrowserMint> {
  await h.ready;
  const { res, b } = await browserCreateArtwork(h, artworkId, o);
  if (!b) throw new Error(`artwork order failed: ${JSON.stringify(res.body)}`);
  const r = await browserReveal(h, b);
  if (r.status !== 200) throw new Error(`reveal failed: ${JSON.stringify(r.body)}`);
  b.order = r.body as Order;
  return b;
}

export interface FundArtworkOptions {
  /** Commit output value (default: the quote's). */
  commitValue?: bigint;
  /** Royalty output value; default the quote's; 0 omits the output. */
  royalty?: bigint;
  /** Club fee output value; default the quote's; 0 omits the output. */
  clubFee?: bigint;
  /** Pay the royalty to this address instead of the artist's (wrong script). */
  royaltyTo?: string;
  clubTo?: string;
  confirmed?: boolean;
  rbf?: boolean;
  /** Extra change output (default: yes, 5,000 sats to the recipient). */
  change?: boolean;
}

/** The minter's wallet broadcasts the funding tx `[commit, artist royalty, club fee, change]` (plan §3.2). */
export function fundArtwork(h: Harness, b: BrowserMint, opts: FundArtworkOptions = {}): void {
  const q = b.order.quote!;
  const script = (a: string) => bytesToHex(addressToScript(a, NET));
  const vout: Array<{ value: bigint; scriptHex: string }> = [{ value: opts.commitValue ?? BigInt(q.commitValueSats), scriptHex: script(q.commitAddress!) }];
  const royalty = opts.royalty ?? BigInt(q.artistRoyaltySats ?? 0);
  if (royalty > 0n) vout.push({ value: royalty, scriptHex: script(opts.royaltyTo ?? q.artistAddress!) });
  const clubFee = opts.clubFee ?? BigInt(q.clubFeeSats ?? 0);
  if (clubFee > 0n) vout.push({ value: clubFee, scriptHex: script(opts.clubTo ?? h.settings.serviceFeeAddress!) });
  if (opts.change ?? true) vout.push({ value: 5_000n, scriptHex: script(b.recipientAddress) });
  h.chain.addTx({ txid: b.commitTxid!, vin: [{ txid: fakeTxid(999_998), vout: 0 }], vout, confirmed: opts.confirmed ?? false, ...(opts.rbf ? { rbf: true } : {}) });
}

export { FakeArtReview };
