/**
 * Test harness: the full service on in-memory adapters, a fake clock, a fake vision reviewer and
 * two API keys (house reviewer, mint service). Also a "wallet" that does exactly what the browser
 * does: sign the SIWB challenge (BIP-322 simple or legacy) and the payout proof.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { getAddress, type TEST_NETWORK } from '@scure/btc-signer';
import { InMemoryApiKeyStore, generateApiKey } from '@bsh/edge';
import { InMemoryNonceStore, SessionKeyRing, generateSigningKey, networkParams, signBip322Simple, signLegacyMessage, type BitcoinNetwork } from '@bsh/identity';
import { DEGENT_RULES_CONFIG, MAX_UPLOAD_BYTES } from '@bsh/degent-mint-sdk';
import { ManualClock } from '@bsh/events';
import { createApp } from '../../src/app.js';
import { StudioService } from '../../src/application/studio-service.js';
import type { StudioSettings } from '../../src/application/settings.js';
import { MemoryContentStore } from '../../src/adapters/content-stores.js';
import { MemoryArtistStore, MemoryArtworkStore, MemoryRoyaltyStore } from '../../src/adapters/memory-stores.js';
import { CompositeArtReview, RulesArtReview } from '../../src/adapters/rules-art-review.js';
import { MemoryEventBus } from '../../src/adapters/system.js';
import { BshArtistNotifier } from '../../src/adapters/bsh-artist-notifier.js';
import type { Artwork } from '../../src/domain/artwork.js';
import { payoutMessage } from '../../src/domain/artist.js';
import type { ArtReview } from '../../src/ports/art-review.js';
import { FakeClock, FakeVisionReview } from './misc.js';
import { FakeTelegram, FakeWebhookReceiver } from './notify.js';
import { squareArt } from './images.js';

export const NET: BitcoinNetwork = 'regtest';
export const DOMAIN = 'localhost:8790';

/** Deterministic test keys (never use outside tests). */
export const key = (n: number): Uint8Array => hexToBytes(n.toString(16).padStart(64, '0'));
export type AddrKind = 'tr' | 'wpkh' | 'pkh';
export function addr(kind: AddrKind, priv: Uint8Array, network: BitcoinNetwork = NET): string {
  return getAddress(kind, priv, networkParams(network) as typeof TEST_NETWORK);
}

export interface HarnessOptions {
  vision?: ArtReview;
  corsOrigins?: string[];
  rateLimitPerMinute?: number;
  settings?: Partial<StudioSettings>;
  /** Wire the Telegram channel (default true). */
  telegram?: boolean;
  /** No notifier at all (notifications disabled). */
  noNotifier?: boolean;
}

export function makeHarness(opts: HarnessOptions = {}) {
  const clock = new FakeClock();
  const settings: StudioSettings = {
    network: NET,
    version: 'test',
    rules: { ...structuredClone(DEGENT_RULES_CONFIG), network: NET },
    maxUploadBytes: MAX_UPLOAD_BYTES,
    siwb: { domain: DOMAIN, uri: `http://${DOMAIN}`, ttlSeconds: 300, statement: null },
    session: { ttlSeconds: 3600, issuer: 'degent-studio', audience: 'degent', scopes: ['artist'] },
    publicBaseUrl: '',
    visionReview: 'claude',
    ...opts.settings,
  };
  const artists = new MemoryArtistStore();
  const artworks = new MemoryArtworkStore();
  const royalties = new MemoryRoyaltyStore();
  const nonces = new InMemoryNonceStore();
  const content = new MemoryContentStore();
  const events = new MemoryEventBus();
  const vision = opts.vision ?? new FakeVisionReview();
  const review = new CompositeArtReview([new RulesArtReview(settings.rules), vision]);
  const keys = new SessionKeyRing(generateSigningKey('test-1'));
  // Artist notifications: the real @bsh/notify channels over fake transports; retries on a manual clock.
  const webhooks = new FakeWebhookReceiver();
  const telegram = new FakeTelegram();
  const notifyClock = new ManualClock(clock.now());
  const notifier = opts.noNotifier
    ? undefined
    : new BshArtistNotifier({
        artists,
        fetch: webhooks.fetch,
        telegram: opts.telegram === false ? null : telegram,
        clock: notifyClock,
        nowSec: () => Math.floor(clock.now().getTime() / 1000),
        random: () => 0.5,
      });
  let n = 0;
  const service = new StudioService({
    settings,
    artists,
    artworks,
    royalties,
    nonces,
    content,
    review,
    events,
    keys,
    clock,
    ...(notifier ? { notifier } : {}),
    newId: () => `art_test${String(++n).padStart(4, '0')}`,
  });

  const apiKeys = new InMemoryApiKeyStore();
  const reviewerKey = generateApiKey('test');
  const mintKey = generateApiKey('test');
  const bothKey = generateApiKey('test');
  apiKeys.add({ id: 'house-1', hash: reviewerKey.hash, env: 'test', scopes: ['studio:review'] });
  apiKeys.add({ id: 'mint-1', hash: mintKey.hash, env: 'test', scopes: ['studio:internal'] });
  apiKeys.add({ id: 'ops-1', hash: bothKey.hash, env: 'test', scopes: ['studio:review', 'studio:internal'] });

  const app = createApp({
    service,
    apiKeyStore: apiKeys,
    apiKeyEnvironment: 'test',
    clock,
    corsOrigins: opts.corsOrigins ?? ['https://degent.club'],
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 10_000,
  });
  return {
    clock,
    settings,
    artists,
    artworks,
    royalties,
    nonces,
    content,
    events,
    vision,
    review,
    keys,
    service,
    app,
    apiKeys,
    reviewerKey: reviewerKey.key,
    mintKey: mintKey.key,
    bothKey: bothKey.key,
    notifier,
    webhooks,
    telegram,
    notifyClock,
  };
}

export type Harness = ReturnType<typeof makeHarness>;

// ----------------------------------------------------------------------------- HTTP helpers

export interface Init {
  json?: unknown;
  bytes?: Uint8Array;
  token?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ip?: string;
}

export async function api(h: Harness, method: string, path: string, init: Init = {}) {
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
  if (init.apiKey) headers['x-api-key'] = init.apiKey;
  const res = await h.app.request(path, { method, headers, body }, { incoming: { socket: { remoteAddress: init.ip ?? '127.0.0.1' } } });
  const ct = res.headers.get('content-type') ?? '';
  const raw = new Uint8Array(await res.arrayBuffer());
  const text = ct.startsWith('application/json') ? new TextDecoder().decode(raw) : '';
  return { status: res.status, body: text ? JSON.parse(text) : null, raw, headers: res.headers };
}

// ----------------------------------------------------------------------------- the "wallet"

export interface Wallet {
  priv: Uint8Array;
  kind: AddrKind;
  address: string;
  /** Sign a message the way the wallet would for this address kind. */
  sign(message: string): string;
}

export function wallet(seed: number, kind: AddrKind = 'tr'): Wallet {
  const priv = key(seed);
  const address = addr(kind, priv);
  const sign = (message: string): string =>
    kind === 'pkh' ? signLegacyMessage(priv, message, 'p2pkh') : signBip322Simple(priv, kind === 'tr' ? 'p2tr' : 'p2wpkh', message);
  return { priv, kind, address, sign };
}

export interface Session {
  wallet: Wallet;
  address: string;
  token: string;
}

/** Full SIWB round trip: challenge -> sign -> verify. */
export async function signIn(h: Harness, w: Wallet | number = 1): Promise<Session> {
  const wal = typeof w === 'number' ? wallet(w) : w;
  const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address: wal.address, network: NET } });
  if (ch.status !== 201) throw new Error(`challenge failed: ${JSON.stringify(ch.body)}`);
  const v = await api(h, 'POST', '/v1/auth/verify', { json: { message: ch.body.message, signature: wal.sign(ch.body.message), address: wal.address } });
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  return { wallet: wal, address: wal.address, token: v.body.token };
}

/** Prove a payout address: the payout wallet signs the payout message for the session subject. */
export function payoutProof(payout: Wallet, sessionSub: string): { address: string; signature: string } {
  return { address: payout.address, signature: payout.sign(payoutMessage(payout.address, sessionSub)) };
}

// ----------------------------------------------------------------------------- artworks

export interface Submission {
  artworkId: string;
  uploadToken: string;
  bytes: Uint8Array;
  artwork: Artwork;
}

export async function declare(h: Harness, s: Session, o: { bytes?: Uint8Array; contentType?: string; title?: string; description?: string } = {}): Promise<Submission> {
  const bytes = o.bytes ?? squareArt();
  const res = await api(h, 'POST', '/v1/artworks', {
    token: s.token,
    json: { title: o.title ?? 'Gentleman No. 1', ...(o.description !== undefined ? { description: o.description } : {}), contentType: o.contentType ?? 'image/jpeg', contentLength: bytes.length },
  });
  if (res.status !== 201) throw new Error(`declare failed: ${JSON.stringify(res.body)}`);
  return { artworkId: res.body.artwork.id, uploadToken: res.body.uploadToken, bytes, artwork: res.body.artwork };
}

export async function upload(h: Harness, sub: Submission): Promise<Artwork> {
  const res = await api(h, 'PUT', `/v1/artworks/${sub.artworkId}/content`, { bytes: sub.bytes, token: sub.uploadToken });
  if (res.status !== 200) throw new Error(`upload failed: ${JSON.stringify(res.body)}`);
  sub.artwork = res.body as Artwork;
  return sub.artwork;
}

/** Declare + upload (approved with the default fake vision reviewer). */
export async function submit(h: Harness, s: Session, o: Parameters<typeof declare>[2] = {}): Promise<Submission> {
  const sub = await declare(h, s, o);
  await upload(h, sub);
  return sub;
}
