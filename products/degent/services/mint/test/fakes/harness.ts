/**
 * Test harness: the full service (API + worker) on in-memory adapters, a fake regtest chain,
 * fake clock and capturing broadcasters. Also a "browser" that does exactly what the front end
 * does: ephemeral key, create order, upload bytes, build the half-signed reveal, submit it.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { p2tr } from '@scure/btc-signer';
import { addressToScript, buildHalfSignedReveal, buildResignedRescue, commitAddress, networkParams } from '@bsh/inscription';
import type { CreateOrderResponse, Order, RescueInputs, Tier } from '@bsh/degent-mint-sdk';
import { DEFAULT_CONFIG, MAX_UPLOAD_BYTES, sha256Hex, tierForSize } from '@bsh/degent-mint-sdk';
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

export function fakeTxid(n: number): string {
  return sha256Hex(new TextEncoder().encode(`fake-tx-${n}`));
}

export interface HarnessOptions {
  review?: ArtReview;
  corsOrigins?: string[];
  rateLimit?: { windowMs: number; max: number };
  settings?: Partial<MintSettings>;
  parentValue?: bigint;
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
    ...opts.settings,
  };
  const store = new MemoryOrderStore();
  const content = new MemoryContentStore();
  const blobs = new MemorySecretBlobStore();
  const reveals = new EncryptedRevealVault(blobs, TEST_KEY);
  const events = new MemoryEventBus();
  const review = opts.review ?? new RulesArtReview(settings.collection);
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

  return { clock, chain, signer, settings, store, content, blobs, reveals, events, orders, parents, app, broadcasters, worker, ready, collectionScriptHex, parentTxid, parentValue };
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
  const content = { contentType: b.contentType, body: b.bytes, parentId: h.settings.collection.parentInscriptionId! };
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
  const rescue = buildResignedRescue({
    network: NET,
    revealPrivkey: b.revealKey,
    content: { contentType: inputs.contentType, body: b.bytes, ...(inputs.parentInscriptionId ? { parentId: inputs.parentInscriptionId } : {}) },
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

export { FakeArtReview };
