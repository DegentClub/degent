/**
 * Test harness: the full service (API + worker) on in-memory adapters, a fake regtest chain,
 * fake clock and capturing broadcasters. Also a "browser" that does exactly what the front end
 * does: ephemeral key, create order, upload bytes, build the half-signed reveal, submit it.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { p2tr } from '@scure/btc-signer';
import { addressToScript, buildHalfSignedReveal, buildResignedRescue, commitAddress, networkParams } from '@bsh/inscription';
import { signBip322Simple } from '@bsh/identity';
import type { AuthVerifyResponse, CreateOrderResponse, Order, RescueResponse, Tier, VoteChoice, VotesResponse } from '@bsh/degent-mint-sdk';
import { DEFAULT_APPROVAL_QUORUM, DEFAULT_CONFIG, DEFAULT_DECLINE_QUORUM, DEFAULT_REVIEW_SLA_SECONDS, GALLERY_SIZE, MAX_UPLOAD_BYTES, sha256Hex, voteReference, voteStatement } from '@bsh/degent-mint-sdk';
import { ApprovalService } from '../../src/application/approval-service.js';
import { RegisterService } from '../../src/application/register-service.js';
import { MemoryHolderRegistry } from '../../src/adapters/memory-holder-registry.js';
import { MemoryVoteStore } from '../../src/adapters/vote-stores.js';
import type { RosterMember } from '../../src/domain/roster.js';
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
import { OrderNotificationService } from '../../src/application/notification-service.js';
import { MemoryOrderSubscriptionStore } from '../../src/adapters/order-subscription-stores.js';
import { ConsoleEmailSender, type TelegramClient, type TelegramSendResult } from '@bsh/notify';
import { ManualClock } from '@bsh/events';
import type { ArtReview } from '../../src/ports/art-review.js';
import { FakeChain } from './chain.js';
import { FakeArtReview, FakeBroadcaster, FakeClock } from './misc.js';
import { png } from './images.js';

export const NET = 'regtest' as const;
export const TEST_KEY = '11'.repeat(32);
export const PARENT_KEY = new Uint8Array(32).fill(7);

export function regtestKey(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

export function regtestAddress(seed: number): string {
  return p2tr(schnorr.getPublicKey(regtestKey(seed)), undefined, networkParams(NET)).address!;
}

/** Club members for tests: seeds 101.. hold Gallery Degents #1.. (one each), seed 200 holds #100 and #101. */
export const MEMBER_SEEDS = [101, 102, 103, 104, 105] as const;
export const SESSION_KEY = { kid: 'test', secretKey: new Uint8Array(32).fill(9) };
export const SIWB_DOMAIN = 'degent.club';

/** A tiny Gallery roster (5 members) so register tests do not need the 1 MB data file. */
export function tinyRoster(): RosterMember[] {
  return [1, 2, 3, 4, 5].map((n) => ({
    n,
    inscriptionId: `${sha256Hex(new TextEncoder().encode(`roster-${n}`))}i0`,
    inscriptionNumber: 93_000_000 + n,
    sat: 1_000_000_000_000 + n,
    sizeKb: 300 + n,
    bytes: (300 + n) * 1024,
    height: n === 1 ? null : 880_000 + n,
    timestamp: n === 1 ? null : new Date(Date.UTC(2025, 0, 1 + n * 8)).toISOString(),
  }));
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
  roster?: RosterMember[];
  /** Leave the telegram channel unconfigured (503 channel_unavailable). */
  noTelegram?: boolean;
}

/** Telegram fake: records messages; `failNext` makes the next N sends fail (retryable). */
export class FakeTelegram implements TelegramClient {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  failNext = 0;
  async sendMessage(chatId: string, text: string): Promise<TelegramSendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, retryable: true, status: 502, error: 'telegram HTTP 502: bad gateway' };
    }
    this.sent.push({ chatId, text });
    return { ok: true, status: 200 };
  }
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
    serviceFeeAddress: null,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    standardConcurrency: 3,
    confirmations: 1,
    latePaymentWindowSeconds: 86_400,
    policy,
    approval: { approvalQuorum: DEFAULT_APPROVAL_QUORUM, declineQuorum: DEFAULT_DECLINE_QUORUM, reviewSlaSeconds: DEFAULT_REVIEW_SLA_SECONDS, gallerySize: GALLERY_SIZE },
    auth: { domain: SIWB_DOMAIN, uri: null, challengeTtlSeconds: 300, sessionTtlSeconds: 3600, audience: 'degent' },
    ordPublicUrl: 'https://ord.test',
    galleryInscriptionId: null,
    ...opts.settings,
  };
  const store = new MemoryOrderStore();
  const content = new MemoryContentStore();
  const blobs = new MemorySecretBlobStore();
  const reveals = new EncryptedRevealVault(blobs, TEST_KEY);
  const events = new MemoryEventBus();
  const review = opts.review ?? new RulesArtReview(settings.collection);
  const votes = new MemoryVoteStore();
  const holders = new MemoryHolderRegistry();
  MEMBER_SEEDS.forEach((seed, i) => holders.set(regtestAddress(seed), [i + 1]));
  holders.set(regtestAddress(200), [100, 101]);
  const roster = opts.roster ?? tinyRoster();
  const parents = new StoreParentUtxoProvider(store);
  let n = 0;
  const orders = new OrderService({
    settings,
    store,
    content,
    reveals,
    review,
    events,
    clock,
    chain,
    votes,
    parents,
    newId: () => `dgt_test${String(++n).padStart(4, '0')}`,
  });
  const approval = new ApprovalService({ orders, store, votes, holders, clock, sessionKey: SESSION_KEY });
  const register = new RegisterService({ settings, roster, store, holders, clock, statsCacheSeconds: 0 });
  const ready = parents.initialise({
    txid: parentTxid,
    vout: 0,
    value: parentValue,
    scriptHex: collectionScriptHex,
    confirmed: true,
    createdByLane: null,
  });
  const fees = new StaticFees({ standard: { slow: 1, normal: 2, fast: 5 }, block: { min: 1, recommended: 3 } }, () => clock.now());
  const email = new ConsoleEmailSender(() => {});
  const telegram = new FakeTelegram();
  const retryClock = new ManualClock(Date.UTC(2026, 8, 24));
  const subscriptions = new MemoryOrderSubscriptionStore();
  const notifications = new OrderNotificationService({
    orders,
    subscriptions,
    email,
    telegram: opts.noTelegram ? null : telegram,
    clock,
    retryClock,
    siteUrl: 'https://degent.club',
  });
  notifications.attach(events);
  const app = createApp({
    orders,
    approval,
    register,
    notifications,
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

  return { email, telegram, retryClock, subscriptions, notifications, clock, chain, signer, settings, store, content, blobs, reveals, events, orders, approval, register, votes, holders, roster, parents, app, broadcasters, worker, ready, collectionScriptHex, parentTxid, parentValue };
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
      tier: o.tier ?? (bytes.length > 390_000 ? 'block' : 'standard'),
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

/** Builds the half-signed reveal exactly as the browser does, then submits it. */
export async function browserReveal(h: Harness, b: BrowserMint, commitTxid = fakeTxid(1000 + Math.floor(Math.random() * 1e6))) {
  const quote = b.order.quote!;
  const content = { contentType: b.contentType, body: b.bytes, parentId: h.settings.collection.parentInscriptionId! };
  const commit = commitAddress(schnorr.getPublicKey(b.revealKey), content, NET);
  if (commit.address !== quote.commitAddress) throw new Error('browser and service disagree on the commit address');
  const { psbtBase64 } = buildHalfSignedReveal({
    network: NET,
    revealPrivkey: b.revealKey,
    content,
    commitOutpoint: { txid: commitTxid, vout: 0 },
    commitValue: BigInt(quote.commitValueSats),
    recipientAddress: b.recipientAddress,
    postage: BigInt(quote.postageSats),
    // SIGHASH_ALL|ANYONECANPAY (0x81, ADR-0005): the parent return is signed up front from the quote
    parentReturnAddress: quote.parentReturnAddress,
    parentValue: BigInt(quote.parentValueSats!),
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
 * Self-rescue exactly as the browser does it (ADR-0005): GET /rescue returns parameters, the browser checks
 * the content hash and its key, then re-signs [commit] -> [child] with K_e via @bsh/inscription.
 */
export async function browserRescue(h: Harness, b: BrowserMint) {
  const res = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
  if (res.status !== 200) throw new Error(`rescue failed: ${JSON.stringify(res.body)}`);
  const p = res.body as RescueResponse;
  const body = new Uint8Array(Buffer.from(p.contentBase64, 'base64'));
  if (sha256Hex(body) !== p.contentSha256 || p.contentSha256 !== b.order.contentSha256) throw new Error('rescue content hash mismatch');
  if (p.revealPubkey !== b.revealPubkey) throw new Error('rescue is for another key');
  const tx = buildResignedRescue({
    network: p.network,
    revealPrivkey: b.revealKey,
    content: { contentType: p.contentType, body, ...(p.parentInscriptionId ? { parentId: p.parentInscriptionId } : {}) },
    commitOutpoint: p.commitOutpoint,
    commitValue: BigInt(p.commitValueSats),
    recipientAddress: p.recipientAddress,
    postage: BigInt(p.postageSats),
    feeRate: p.feeRate,
  });
  return { params: p, tx };
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

// ----------------------------------------------------------------------------- members (ADR-0007)

/** SIWB sign-in as the holder with `seed`: challenge -> BIP-322 sign -> verify. Returns the session. */
export async function signIn(h: Harness, seed: number): Promise<AuthVerifyResponse> {
  const address = regtestAddress(seed);
  const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address } });
  if (ch.status !== 200) throw new Error(`challenge failed: ${JSON.stringify(ch.body)}`);
  const signature = signBip322Simple(regtestKey(seed), 'p2tr', ch.body.message);
  const v = await api(h, 'POST', '/v1/auth/verify', { json: { address, message: ch.body.message, signature } });
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  return v.body as AuthVerifyResponse;
}

/** Sign the vote statement for `order` with the member's key (what the wallet does in the browser). */
export function signVote(seed: number, order: Pick<Order, 'id' | 'inscriptionId' | 'contentSha256'>, vote: VoteChoice) {
  const message = voteStatement(vote, order.id, voteReference(order));
  return { vote, message, signature: signBip322Simple(regtestKey(seed), 'p2tr', message) };
}

/** Sign in as `seed` and cast a vote on the order. Returns the raw API response. */
export async function castVote(h: Harness, seed: number, orderId: string, vote: VoteChoice, token?: string) {
  const session = token ?? (await signIn(h, seed)).token;
  const order = (await api(h, 'GET', `/v1/orders/${orderId}`)).body as Order;
  return api(h, 'POST', `/v1/orders/${orderId}/votes`, { json: signVote(seed, order, vote), token: session });
}

/** Fund the commit (confirmed) and tick until the order sits in member_review. */
export async function fundToReview(h: Harness, b: BrowserMint): Promise<Order> {
  fundCommit(h, b, { confirmed: true });
  await h.worker.tick();
  const o = (await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order;
  if (o.status !== 'member_review') throw new Error(`expected member_review, got ${o.status}`);
  return o;
}

/** The members approve: `quorum` distinct holders vote approve. Returns the last tally. */
export async function membersApprove(h: Harness, orderId: string, quorum = h.settings.approval.approvalQuorum): Promise<VotesResponse> {
  let last: VotesResponse | null = null;
  for (const seed of MEMBER_SEEDS.slice(0, quorum)) {
    const r = await castVote(h, seed, orderId, 'approve');
    if (r.status !== 200) throw new Error(`vote failed: ${JSON.stringify(r.body)}`);
    last = r.body as VotesResponse;
  }
  return last!;
}

/** Fund (confirmed), reach member_review, get approved: the order is `queued` afterwards. */
export async function fundAndApprove(h: Harness, b: BrowserMint): Promise<Order> {
  await fundToReview(h, b);
  await membersApprove(h, b.orderId);
  const o = (await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order;
  if (o.status !== 'queued') throw new Error(`expected queued, got ${o.status}`);
  return o;
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
