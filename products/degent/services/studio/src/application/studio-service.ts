/**
 * Application service: every mutation (API) goes through here so that each artwork transition is
 * validated by the transition table, persisted with a timestamp and emitted as an event, and every
 * identity fact (session, payout address) is proven before it is stored.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CollectionConfig } from '@bsh/degent-mint-sdk';
import { DEGENT_RULES, DEGENT_RULES_VERSION, formatAdvice, isSha256Hex, recommendedContentType, validateContentMeta } from '@bsh/degent-mint-sdk';
import {
  SessionError,
  SiwbError,
  decodeAddress,
  issueChallenge,
  verifyBip322Simple,
  verifySignIn,
  type NonceStore,
  type SessionClaims,
  type SessionKeyRing,
} from '@bsh/identity';
import {
  DISPLAY_NAME_MAX_CHARS,
  PAYOUT_ADDRESS_KINDS,
  PAYOUT_MESSAGE_TEMPLATE,
  payoutMessage,
  toArtist,
  toPublicArtist,
  type Artist,
  type ArtistNotifyRecord,
  type ArtistRecord,
  type PublicArtist,
} from '../domain/artist.js';
import {
  APPEALS_PER_ARTWORK,
  APPEAL_MESSAGE_MAX_CHARS,
  APPEAL_STATUSES,
  ARTWORK_ID,
  DESCRIPTION_MAX_CHARS,
  FEATURED_RANK_MAX,
  MAX_EDITIONS_LIMIT,
  TITLE_MAX_CHARS,
  isArtworkStatus,
  openAppeal,
  toPublicArtwork,
  transition,
  type AppealRecord,
  type AppealStatus,
  type Artwork,
  type ArtworkRecord,
  type ArtworkReview,
  type ArtworkStatus,
  type AutomatedReview,
  type HouseReview,
} from '../domain/artwork.js';
import { DomainError, StaleWriteError, conflict, forbidden, invalid, notFound, unauthorized } from '../domain/errors.js';
import { eventFor } from '../domain/events.js';
import { artworkNotification, royaltyNotification, type ArtistNotification } from '../domain/notifications.js';
import { sameRoyaltyFacts, type RoyaltyRecord, type RoyaltyTotals } from '../domain/royalty.js';
import type { ArtistNotifier } from '../ports/artist-notifier.js';
import type { ArtReview } from '../ports/art-review.js';
import type { ArtistStore } from '../ports/artist-store.js';
import type { ArtworkStore } from '../ports/artwork-store.js';
import type { Clock } from '../ports/clock.js';
import type { ContentStore } from '../ports/content-store.js';
import type { EventBus } from '../ports/event-bus.js';
import type { RoyaltyStore } from '../ports/royalty-store.js';
import type { StudioSettings } from './settings.js';
import { silentLogger, type Logger } from './logger.js';

export interface StudioServiceDeps {
  settings: StudioSettings;
  artists: ArtistStore;
  artworks: ArtworkStore;
  royalties: RoyaltyStore;
  nonces: NonceStore;
  content: ContentStore;
  review: ArtReview;
  events: EventBus;
  keys: SessionKeyRing;
  clock: Clock;
  /** Artist notifications (ADR-0012); absent = none are sent and `notify` targets cannot be registered. */
  notifier?: ArtistNotifier;
  log?: Logger;
  newId?: () => string;
  newToken?: () => string;
  /** Webhook signing secrets (`whsec_` + 256-bit base64url). */
  newWebhookSecret?: () => string;
}

/** Who is asking: nobody, a signed-in artist, or an API key principal (house reviewer / mint service). */
export type Viewer = { kind: 'anonymous' } | { kind: 'artist'; address: string } | { kind: 'apiKey'; id: string; scopes: readonly string[] };
export const ANONYMOUS: Viewer = { kind: 'anonymous' };

export interface ChallengeResult {
  message: string;
  nonce: string;
  address: string;
  network: StudioSettings['network'];
  issuedAt: string;
  expiresAt: string;
}

export interface SessionResult {
  token: string;
  expiresAt: string;
  method: 'bip322-simple' | 'legacy';
  artist: Artist;
}

export interface ArtworkListResult {
  items: Artwork[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AppealListResult {
  items: AppealRecord[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AppealResult {
  appeal: AppealRecord;
  artwork: Artwork;
}

export interface RoyaltiesResult {
  items: RoyaltyRecord[];
  totals: RoyaltyTotals;
  page: number;
  pageSize: number;
  total: number;
}

const BEARER = /^Bearer\s+(\S+)$/i;
const UPLOAD_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Control characters plus zero-width / line-separator code points (built from code points so no tool mangles the escapes).
const CONTROL_RE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x2028, 0x2029, 0xfeff)}]`, 'u');
export const PAGE_SIZE_DEFAULT = 24;
export const PAGE_SIZE_MAX = 100;
export const WEBHOOK_URL_MAX_CHARS = 2048;
/** How often a royalty's mintedEditions refresh retries a concurrent artwork write. */
const MINTED_REFRESH_ATTEMPTS = 5;

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, field: string, max: number, opts: { required?: boolean; min?: number } = {}): string | null {
  if (v === undefined || v === null) {
    if (opts.required) throw invalid(`${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw invalid(`${field} must be a string`);
  const s = v.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (CONTROL_RE.test(v)) throw invalid(`${field} must not contain control characters`);
  if (s.length < (opts.min ?? (opts.required ? 1 : 0))) throw invalid(`${field} must not be empty`);
  if (s.length > max) throw invalid(`${field} must be at most ${max} characters`);
  return s.length === 0 ? null : s;
}

export function parsePage(raw: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number } {
  const num = (v: unknown, field: string, def: number, max: number): number => {
    if (v === undefined || v === null || v === '') return def;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`${field} must be an integer in 1..${max}`);
    return n;
  };
  return { page: num(raw.page, 'page', 1, 1_000_000), pageSize: num(raw.pageSize, 'pageSize', PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX) };
}

/** `maxEditions`: an integer 1..MAX_EDITIONS_LIMIT or null (open edition). */
function parseMaxEditions(v: unknown): number | null {
  if (v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_EDITIONS_LIMIT)
    throw invalid(`maxEditions must be an integer in 1..${MAX_EDITIONS_LIMIT}, or null for an open edition`);
  return v as number;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid(`unknown field ${k}`);
}

export class StudioService {
  readonly settings: StudioSettings;
  private readonly d: StudioServiceDeps;
  private readonly newId: () => string;
  private readonly newToken: () => string;
  private readonly newWebhookSecret: () => string;
  private readonly log: Logger;
  /** Notifications in flight (fire-and-forget from the request's point of view). */
  private readonly inflight = new Set<Promise<void>>();

  constructor(deps: StudioServiceDeps) {
    this.d = deps;
    this.settings = deps.settings;
    this.log = deps.log ?? silentLogger;
    this.newId = deps.newId ?? (() => `art_${randomBytes(12).toString('hex')}`);
    this.newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));
    this.newWebhookSecret = deps.newWebhookSecret ?? (() => `whsec_${randomBytes(32).toString('base64url')}`);
  }

  get rules(): CollectionConfig {
    return this.settings.rules;
  }

  private now(): string {
    return this.d.clock.now().toISOString();
  }

  private contentUrl(id: string): string {
    return `${this.settings.publicBaseUrl}/v1/artworks/${id}/content`;
  }

  /** `includePrivate`: the viewer is the owner or an API key (appeals are shown). */
  private toPublic(r: ArtworkRecord, includePrivate = false): Artwork {
    return toPublicArtwork(r, (id) => this.contentUrl(id), includePrivate);
  }

  private isPrivileged(r: ArtworkRecord, viewer: Viewer): boolean {
    return viewer.kind === 'apiKey' || (viewer.kind === 'artist' && viewer.address === r.artist);
  }

  // ------------------------------------------------------------------ notifications (ADR-0012)

  /**
   * Tell the artist, without making the caller wait or fail: the delivery runs in the background and any
   * error is logged. The artist record is read at send time (targets may have changed since).
   */
  private notifyArtist(address: string, n: ArtistNotification, eventId: string): void {
    const notifier = this.d.notifier;
    if (!notifier) return;
    const p: Promise<void> = (async () => {
      const a = await this.d.artists.get(address);
      if (!a?.notify || (!a.notify.webhookUrl && !a.notify.telegramChatId)) return;
      await notifier.notify({ address: a.address, notify: a.notify }, n, eventId);
    })()
      .catch((e: unknown) => this.log.warn('artist notification failed', { artist: address, kind: n.kind, eventId, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Resolves when every notification started so far has had its first delivery attempt (tests, shutdown). */
  async notificationsIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ------------------------------------------------------------------ service

  config() {
    const s = this.settings;
    return {
      network: s.network,
      rulesVersion: DEGENT_RULES_VERSION,
      rules: DEGENT_RULES.map((r) => ({ ...r })),
      recommendedContentType,
      allowedContentTypes: [...s.rules.allowedContentTypes],
      tiers: s.rules.tiers.map((t) => ({ tier: t.tier, label: t.label, minBytes: t.minBytes, maxBytes: t.maxBytes })),
      minDimensionPx: s.rules.minDimensionPx,
      maxDimensionPx: s.rules.maxDimensionPx,
      maxUploadBytes: s.maxUploadBytes,
      titleMaxChars: TITLE_MAX_CHARS,
      descriptionMaxChars: DESCRIPTION_MAX_CHARS,
      displayNameMaxChars: DISPLAY_NAME_MAX_CHARS,
      siwb: { domain: s.siwb.domain, uri: s.siwb.uri, ttlSeconds: s.siwb.ttlSeconds },
      session: { ttlSeconds: s.session.ttlSeconds, audience: s.session.audience, scopes: [...s.session.scopes] },
      payoutMessageTemplate: PAYOUT_MESSAGE_TEMPLATE,
      payoutAddressKinds: [...PAYOUT_ADDRESS_KINDS],
      visionReview: s.visionReview,
      maxEditionsLimit: MAX_EDITIONS_LIMIT,
      featuredRankMax: FEATURED_RANK_MAX,
      appealMessageMaxChars: APPEAL_MESSAGE_MAX_CHARS,
      appealsPerArtwork: APPEALS_PER_ARTWORK,
      notifyChannels: [...(this.d.notifier?.channels ?? [])],
    };
  }

  async health() {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await this.d.artworks.list({ page: 1, pageSize: 1 });
      checks.store = { ok: true };
    } catch {
      checks.store = { ok: false, detail: 'store unavailable' };
    }
    checks.review = { ok: true, detail: this.d.review.name };
    const ok = Object.values(checks).every((x) => x.ok);
    return { status: ok ? ('ok' as const) : ('degraded' as const), network: this.settings.network, version: this.settings.version, time: this.now(), checks };
  }

  // ------------------------------------------------------------------ identity (SIWB)

  async challenge(body: unknown): Promise<ChallengeResult> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    const address = text(body.address, 'address', 90, { required: true })!;
    if (body.network !== this.settings.network)
      throw new DomainError('network_mismatch', 422, `this studio signs artists in on ${this.settings.network}`, { network: this.settings.network });
    try {
      decodeAddress(address, this.settings.network);
    } catch (e) {
      throw invalid(`address is not a supported ${this.settings.network} address (${(e as Error).message})`);
    }
    const s = this.settings.siwb;
    try {
      const ch = await issueChallenge(this.d.nonces, {
        domain: s.domain,
        uri: s.uri,
        address,
        network: this.settings.network,
        ttlSeconds: s.ttlSeconds,
        ...(s.statement ? { statement: s.statement } : {}),
        now: this.d.clock.now(),
      });
      return { message: ch.message, nonce: ch.fields.nonce, address, network: this.settings.network, issuedAt: ch.fields.issuedAt, expiresAt: ch.fields.expirationTime };
    } catch (e) {
      if (e instanceof SiwbError) throw invalid(`cannot issue a challenge: ${e.message}`, { code: e.code });
      throw e;
    }
  }

  async verify(body: unknown): Promise<SessionResult> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    const message = typeof body.message === 'string' && body.message.length <= 4096 ? body.message : null;
    const signature = typeof body.signature === 'string' && body.signature.length <= 4096 ? body.signature : null;
    const address = text(body.address, 'address', 90, { required: true })!;
    if (!message) throw invalid('message is required (the challenge text, at most 4096 characters)');
    if (!signature) throw invalid('signature is required (base64, at most 4096 characters)');
    const r = await verifySignIn(
      { message, signature, address },
      { domain: this.settings.siwb.domain, nonces: this.d.nonces, network: this.settings.network, now: this.d.clock.now() },
    );
    if (!r.ok) throw new DomainError('sign_in_failed', 401, 'sign-in could not be verified', { reason: r.error });
    const now = this.now();
    let artist = await this.d.artists.get(r.address);
    if (!artist) {
      artist = { address: r.address, network: r.network, displayName: null, payoutAddress: null, payoutVerifiedAt: null, joinedAt: now, updatedAt: now, version: 0 };
      await this.d.artists.create(artist);
    }
    const s = this.settings.session;
    const token = this.d.keys.issue(
      { sub: r.address, accounts: [r.address], product: s.audience, scopes: [...s.scopes] },
      { issuer: s.issuer, audience: s.audience, ttlSeconds: s.ttlSeconds, now: this.d.clock.now() },
    );
    const expiresAt = new Date(this.d.clock.now().getTime() + s.ttlSeconds * 1000).toISOString();
    return { token, expiresAt, method: r.method, artist: toArtist(artist, await this.d.artworks.countByArtist(artist.address)) };
  }

  /** Bearer session -> claims (401 otherwise). API keys (`bsh_...`) are not sessions. */
  async authenticate(authorization: string | undefined): Promise<SessionClaims> {
    const m = authorization ? BEARER.exec(authorization.trim()) : null;
    if (!m) throw unauthorized('a session token is required (POST /v1/auth/verify)');
    const token = m[1]!;
    if (token.startsWith('bsh_')) throw unauthorized('an API key is not an artist session');
    const s = this.settings.session;
    let claims: SessionClaims;
    try {
      claims = this.d.keys.verify(token, { issuer: s.issuer, audience: s.audience, requiredScopes: [...s.scopes], now: this.d.clock.now() });
    } catch (e) {
      if (e instanceof SessionError) throw new DomainError('unauthorized', 401, `session ${e.code.replace(/_/g, ' ')}`, { reason: e.code });
      throw e;
    }
    if (!(await this.d.artists.get(claims.sub))) throw unauthorized('unknown artist; sign in again');
    return claims;
  }

  // ------------------------------------------------------------------ artists

  private async artistRecord(address: string): Promise<ArtistRecord> {
    const a = await this.d.artists.get(address);
    if (!a) throw unauthorized('unknown artist; sign in again');
    return a;
  }

  async me(address: string): Promise<Artist> {
    const a = await this.artistRecord(address);
    return toArtist(a, await this.d.artworks.countByArtist(address));
  }

  async updateMe(address: string, body: unknown): Promise<Artist> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    onlyKeys(body, ['displayName', 'payout', 'notify']);
    if (!('displayName' in body) && !('payout' in body) && !('notify' in body)) throw invalid('nothing to update: send displayName, payout and/or notify');
    let a = await this.artistRecord(address);
    const now = this.now();
    let newSecret: string | null = null;
    if ('notify' in body) {
      const r = this.applyNotify(a.notify, body.notify);
      a = { ...a, notify: r.notify, updatedAt: now };
      newSecret = r.newSecret;
    }
    if ('displayName' in body) a = { ...a, displayName: text(body.displayName, 'displayName', DISPLAY_NAME_MAX_CHARS), updatedAt: now };
    if ('payout' in body) {
      const p = body.payout;
      if (!isObject(p)) throw invalid('payout must be an object { address, signature }');
      const payoutAddress = text(p.address, 'payout.address', 90, { required: true })!;
      const signature = typeof p.signature === 'string' && p.signature.length > 0 && p.signature.length <= 4096 ? p.signature : null;
      if (!signature) throw invalid('payout.signature is required (BIP-322 simple, base64)');
      let kind: string;
      try {
        kind = decodeAddress(payoutAddress, this.settings.network).kind;
      } catch (e) {
        throw invalid(`payout.address is not a valid ${this.settings.network} address (${(e as Error).message})`);
      }
      if (!(PAYOUT_ADDRESS_KINDS as readonly string[]).includes(kind))
        throw new DomainError(
          'payout_address_legacy',
          422,
          `payout.address is a legacy ${kind} address; royalties are paid to a segwit (bc1q...) or taproot (bc1p...) address`,
          { kind, accepted: [...PAYOUT_ADDRESS_KINDS] },
        );
      const message = payoutMessage(payoutAddress, address);
      const proof = verifyBip322Simple(payoutAddress, this.settings.network, message, signature);
      if (!proof.valid)
        throw new DomainError('payout_proof_invalid', 422, 'payout.signature is not a valid BIP-322 simple signature by payout.address over the payout message', {
          message,
        });
      a = { ...a, payoutAddress, payoutVerifiedAt: now, updatedAt: now };
    }
    const saved = await this.d.artists.save(a);
    const artist = toArtist(saved, await this.d.artworks.countByArtist(address));
    return newSecret ? { ...artist, notifyWebhookSecret: newSecret } : artist;
  }

  /**
   * `notify` of PUT /v1/artists/me (ADR-0012): null clears both targets; a field left out is unchanged; the
   * webhook signing secret is generated when a webhook is first set (or on `rotateWebhookSecret`) and deleted
   * with the webhook. Targets are validated by the notifier (`@bsh/notify` validateWebhookTarget for URLs).
   */
  private applyNotify(current: ArtistNotifyRecord | undefined, raw: unknown): { notify: ArtistNotifyRecord; newSecret: string | null } {
    const cur: ArtistNotifyRecord = current ?? { webhookUrl: null, telegramChatId: null, webhookSecret: null };
    if (raw === null) return { notify: { webhookUrl: null, telegramChatId: null, webhookSecret: null }, newSecret: null };
    if (!isObject(raw)) throw invalid('notify must be an object { webhookUrl?, telegramChatId?, rotateWebhookSecret? } or null');
    onlyKeys(raw, ['webhookUrl', 'telegramChatId', 'rotateWebhookSecret']);
    const notifier = this.d.notifier;
    const target = (channel: 'webhook' | 'telegram', field: string, v: unknown, max: number): string | null => {
      if (v === null) return null;
      if (typeof v !== 'string' || v.length === 0 || v.length > max || CONTROL_RE.test(v) || /\s/.test(v))
        throw invalid(`notify.${field} must be a string of 1-${max} characters without spaces, or null`);
      if (!notifier) throw invalid('notifications are not enabled on this studio');
      try {
        notifier.validateTarget(channel, v);
      } catch (e) {
        throw invalid(`notify.${field}: ${(e as Error).message}`);
      }
      return v;
    };
    const next: ArtistNotifyRecord = { ...cur };
    if ('webhookUrl' in raw) next.webhookUrl = target('webhook', 'webhookUrl', raw.webhookUrl, WEBHOOK_URL_MAX_CHARS);
    if ('telegramChatId' in raw) next.telegramChatId = target('telegram', 'telegramChatId', raw.telegramChatId, 33);
    const rotate = raw.rotateWebhookSecret;
    if (rotate !== undefined && typeof rotate !== 'boolean') throw invalid('notify.rotateWebhookSecret must be a boolean');
    if (rotate && !next.webhookUrl) throw invalid('notify.rotateWebhookSecret needs a webhookUrl');
    let newSecret: string | null = null;
    if (!next.webhookUrl) next.webhookSecret = null;
    else if (!next.webhookSecret || rotate) next.webhookSecret = newSecret = this.newWebhookSecret();
    return { notify: next, newSecret };
  }

  /** Internal (scope studio:internal): the proven payout address the mint pays the royalty to. */
  async artistPayout(address: string): Promise<{ address: string; payoutAddress: string | null; payoutVerifiedAt: string | null }> {
    const a = await this.d.artists.get(address);
    if (!a) throw notFound('artist');
    return { address: a.address, payoutAddress: a.payoutAddress, payoutVerifiedAt: a.payoutVerifiedAt };
  }

  async publicArtist(address: string): Promise<PublicArtist> {
    const a = await this.d.artists.get(address);
    if (!a) throw notFound('artist');
    return toPublicArtist(a, (await this.d.artworks.countByArtist(address)).approved);
  }

  // ------------------------------------------------------------------ artworks

  async createArtwork(address: string, body: unknown): Promise<{ artwork: Artwork; uploadToken: string }> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    await this.artistRecord(address);
    const title = text(body.title, 'title', TITLE_MAX_CHARS, { required: true })!;
    const description = text(body.description, 'description', DESCRIPTION_MAX_CHARS);
    const contentType = text(body.contentType, 'contentType', 100, { required: true })!.toLowerCase();
    const contentLength = body.contentLength;
    if (!Number.isInteger(contentLength) || (contentLength as number) < 1) throw invalid('contentLength must be a positive integer');
    const maxEditions = body.maxEditions === undefined ? null : parseMaxEditions(body.maxEditions);
    const meta = validateContentMeta({ contentType, contentLength: contentLength as number }, this.rules);
    if (!meta.ok) throw invalid('the declaration does not meet the Degent rules', { checks: meta.checks, advice: formatAdvice(contentType, this.rules).advice });
    const now = this.now();
    const uploadToken = this.newToken();
    const record: ArtworkRecord = {
      id: this.newId(),
      artist: address,
      network: this.settings.network,
      title,
      description,
      contentType,
      contentLength: contentLength as number,
      contentSha256: null,
      status: 'submitted',
      needsHuman: false,
      review: null,
      featured: false,
      featuredAt: null,
      timeline: [{ status: 'submitted', at: now, detail: `${meta.tier!.label}; ${formatAdvice(contentType, this.rules).advice}` }],
      createdAt: now,
      updatedAt: now,
      version: 0,
      uploadTokenHash: sha256hex(uploadToken),
      maxEditions,
      mintedEditions: 0,
      featuredRank: null,
      appeals: [],
    };
    await this.d.artworks.create(record);
    await this.d.events.publish(eventFor(record, null));
    return { artwork: this.toPublic(record, true), uploadToken };
  }

  /**
   * The artist sets or changes the edition cap (ADR-0012). Any value before the first mint; afterwards it may
   * be raised, opened or lowered, never below the editions already minted. Outstanding mint quotes keep
   * their reserved edition either way (the mint checks the cap when it quotes).
   */
  async setEditions(id: string, address: string, body: unknown): Promise<Artwork> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    onlyKeys(body, ['maxEditions']);
    if (!('maxEditions' in body)) throw invalid(`maxEditions is required (an integer in 1..${MAX_EDITIONS_LIMIT}, or null for an open edition)`);
    const maxEditions = parseMaxEditions(body.maxEditions);
    const r = await this.record(id);
    if (r.artist !== address) throw forbidden('only the artist can change the edition cap');
    if (r.status === 'delisted') throw conflict('a delisted artwork cannot change its edition cap', { status: r.status });
    const minted = r.mintedEditions ?? 0;
    if (maxEditions !== null && maxEditions < minted)
      throw conflict(`maxEditions cannot be lower than the ${minted} editions already minted`, { mintedEditions: minted, maxEditions });
    const next = await this.d.artworks.save({ ...r, maxEditions, updatedAt: this.now() });
    return this.toPublic(next, true);
  }

  private async record(id: string): Promise<ArtworkRecord> {
    if (!ARTWORK_ID.test(id)) throw notFound('artwork');
    const r = await this.d.artworks.get(id);
    if (!r) throw notFound('artwork');
    return r;
  }

  /** Upload-token check, done BEFORE the body is read so an unauthorised caller cannot make us buffer 4 MB. */
  async authorizeUpload(id: string, authorization: string | undefined): Promise<ArtworkRecord> {
    const r = await this.record(id);
    const m = authorization ? BEARER.exec(authorization.trim()) : null;
    if (!m || !UPLOAD_TOKEN_RE.test(m[1]!)) throw unauthorized('the upload token is required (Authorization: Bearer <uploadToken>)');
    const given = Buffer.from(sha256hex(m[1]!), 'hex');
    const stored = Buffer.from(r.uploadTokenHash, 'hex');
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw forbidden('wrong upload token for this artwork');
    return r;
  }

  private async transitionAndEmit(r: ArtworkRecord, to: ArtworkStatus, detail?: string): Promise<ArtworkRecord> {
    const previous = r.status;
    const next = await this.d.artworks.save(transition(r, to, this.now(), detail));
    const event = eventFor(next, previous);
    await this.d.events.publish(event);
    const n = artworkNotification(next);
    if (n) this.notifyArtist(next.artist, n, event.eventId);
    return next;
  }

  async uploadContent(id: string, authorization: string | undefined, bytes: Uint8Array): Promise<Artwork> {
    const r = await this.authorizeUpload(id, authorization);
    if (r.status !== 'submitted') throw conflict(`artwork is ${r.status}; content can only be uploaded once`, { status: r.status });
    if (bytes.length !== r.contentLength)
      throw new DomainError('content_mismatch', 422, `uploaded ${bytes.length} bytes but ${r.contentLength} were declared`, { declared: r.contentLength, received: bytes.length });
    const sha = await this.d.content.put(bytes);
    let verdict;
    try {
      verdict = await this.d.review.review({ artworkId: r.id, declaredContentType: r.contentType, bytes });
    } catch {
      throw new DomainError('review_unavailable', 503, 'automated review is temporarily unavailable; retry the upload');
    }
    const automated: AutomatedReview = { approved: verdict.approved, needsHuman: verdict.needsHuman, reasons: verdict.reasons, checks: verdict.checks, reviewer: this.d.review.name };
    const detail = verdict.approved
      ? `automated review passed (${this.d.review.name})`
      : verdict.needsHuman
        ? `waiting for a house reviewer: ${verdict.checks.filter((c) => !c.passed).map((c) => c.detail).join('; ')}`
        : `automated review failed: ${verdict.reasons.join('; ')}`;
    let next = await this.transitionAndEmit(
      { ...r, contentSha256: sha, needsHuman: verdict.needsHuman, review: { automated, house: null, reviewedAt: this.now() } },
      'reviewing',
      detail,
    );
    if (verdict.approved) next = await this.transitionAndEmit(next, 'approved', `approved by ${this.d.review.name}`);
    else if (!verdict.needsHuman) next = await this.transitionAndEmit(next, 'rejected', verdict.reasons.join('; ') || 'rejected by automated review');
    return this.toPublic(next, true);
  }

  private visible(r: ArtworkRecord, viewer: Viewer): boolean {
    return r.status === 'approved' || viewer.kind === 'apiKey' || (viewer.kind === 'artist' && viewer.address === r.artist);
  }

  async getArtwork(id: string, viewer: Viewer): Promise<Artwork> {
    const r = await this.record(id);
    if (!this.visible(r, viewer)) throw notFound('artwork');
    return this.toPublic(r, this.isPrivileged(r, viewer));
  }

  async listArtworks(raw: { status?: unknown; artist?: unknown; available?: unknown; page?: unknown; pageSize?: unknown }, viewer: Viewer): Promise<ArtworkListResult> {
    const { page, pageSize } = parsePage(raw);
    const status = raw.status === undefined || raw.status === '' ? 'approved' : raw.status;
    if (!isArtworkStatus(status)) throw invalid('status must be one of submitted, reviewing, approved, rejected, delisted');
    const artist = text(raw.artist, 'artist', 90) ?? undefined;
    let available: boolean | undefined;
    if (raw.available === true || raw.available === 'true') available = true;
    else if (raw.available === false || raw.available === 'false') available = false;
    else if (raw.available !== undefined && raw.available !== '') throw invalid('available must be true or false');
    if (status !== 'approved') {
      if (viewer.kind === 'anonymous') throw unauthorized('sign in to list submissions that are not approved');
      if (viewer.kind === 'artist' && artist !== viewer.address) throw forbidden('artists can only list their own submissions (set artist to your address)');
    }
    const q = { status, page, pageSize, ...(artist !== undefined ? { artist } : {}), ...(available !== undefined ? { available } : {}) };
    const res = await this.d.artworks.list(q);
    return { items: res.items.map((r) => this.toPublic(r, this.isPrivileged(r, viewer))), page, pageSize, total: res.total };
  }

  async getContent(id: string): Promise<{ bytes: Uint8Array; contentType: string; sha256: string }> {
    const r = await this.record(id);
    if (r.status !== 'approved' || !r.contentSha256 || !isSha256Hex(r.contentSha256)) throw notFound('artwork content');
    const bytes = await this.d.content.get(r.contentSha256);
    if (!bytes) throw notFound('artwork content');
    return { bytes, contentType: r.contentType, sha256: r.contentSha256 };
  }

  async delist(id: string, address: string): Promise<Artwork> {
    const r = await this.record(id);
    if (r.artist !== address) throw forbidden('only the artist can delist an artwork');
    return this.toPublic(await this.transitionAndEmit(r, 'delisted', 'delisted by the artist'), true);
  }

  /**
   * The artist asks for a human review of a rejection (ADR-0012): `rejected -> reviewing` with needsHuman,
   * one open appeal at a time, at most APPEALS_PER_ARTWORK per artwork. The message goes to the house only;
   * the event says `appeal` and nothing else.
   */
  async appeal(id: string, address: string, body: unknown): Promise<AppealResult> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    onlyKeys(body, ['message']);
    const message = text(body.message, 'message', APPEAL_MESSAGE_MAX_CHARS, { required: true })!;
    const r = await this.record(id);
    if (r.artist !== address) throw forbidden('only the artist can appeal a decision on their artwork');
    const appeals = r.appeals ?? [];
    if (openAppeal(r)) throw conflict('an appeal for this artwork is already open', { appeals: appeals.length, max: APPEALS_PER_ARTWORK });
    if (appeals.length >= APPEALS_PER_ARTWORK)
      throw conflict(`an artwork can be appealed at most ${APPEALS_PER_ARTWORK} times`, { appeals: appeals.length, max: APPEALS_PER_ARTWORK });
    if (r.status !== 'rejected')
      throw new DomainError('illegal_transition', 409, `only a rejected artwork can be appealed (artwork is ${r.status})`, { status: r.status, to: 'reviewing' });
    const appeal: AppealRecord = {
      id: `${r.id}:appeal:${appeals.length + 1}`,
      artworkId: r.id,
      artist: r.artist,
      message,
      status: 'open',
      createdAt: this.now(),
      resolvedAt: null,
      resolution: null,
    };
    const next = await this.transitionAndEmit({ ...r, needsHuman: true, appeals: [...appeals, appeal] }, 'reviewing', 'appeal');
    return { appeal: structuredClone(appeal), artwork: this.toPublic(next, true) };
  }

  /** The house appeal queue (scope studio:review), oldest first. */
  async listAppeals(raw: { status?: unknown; page?: unknown; pageSize?: unknown }): Promise<AppealListResult> {
    const { page, pageSize } = parsePage(raw);
    const status = raw.status === undefined || raw.status === '' ? 'open' : raw.status;
    if (typeof status !== 'string' || !(APPEAL_STATUSES as readonly string[]).includes(status)) throw invalid(`status must be one of ${APPEAL_STATUSES.join(', ')}`);
    const res = await this.d.artworks.listAppeals({ status: status as AppealStatus, page, pageSize });
    return { items: res.items, page, pageSize, total: res.total };
  }

  async houseReview(id: string, reviewerId: string, body: unknown): Promise<Artwork> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'reject') throw invalid('decision must be "approve" or "reject"');
    const reasonsRaw = body.reasons ?? [];
    if (!Array.isArray(reasonsRaw) || reasonsRaw.length > 10) throw invalid('reasons must be an array of at most 10 strings');
    const reasons = reasonsRaw.map((x, i) => text(x, `reasons[${i}]`, 200, { required: true })!);
    const r = await this.record(id);
    const to: ArtworkStatus = decision === 'approve' ? 'approved' : 'rejected';
    const now = this.now();
    const house: HouseReview = { decision, reasons, reviewerId, at: now };
    const review: ArtworkReview = { automated: r.review?.automated ?? null, house, reviewedAt: now };
    // A verdict on an appealed artwork resolves the open appeal (ADR-0012).
    const appeals = r.appeals?.map((a) =>
      a.status === 'open' ? { ...a, status: decision === 'approve' ? ('granted' as const) : ('denied' as const), resolvedAt: now, resolution: { ...house, reasons: [...reasons] } } : a,
    );
    const appealed = openAppeal(r) !== null;
    const detail =
      decision === 'approve'
        ? `approved by the house${appealed ? ' (appeal granted)' : ''}`
        : `rejected by the house${appealed ? ' (appeal denied)' : ''}${reasons.length ? `: ${reasons.join('; ')}` : ''}`;
    return this.toPublic(await this.transitionAndEmit({ ...r, review, needsHuman: false, ...(appeals ? { appeals } : {}) }, to, detail), true);
  }

  /**
   * House curation: `featured`, plus an optional `rank` (1..FEATURED_RANK_MAX, lower first) ordering the front
   * room (ADR-0012). `rank` left out keeps the current rank, null clears it; unfeaturing clears it.
   */
  async feature(id: string, reviewerId: string, body: unknown): Promise<Artwork> {
    if (!isObject(body) || typeof body.featured !== 'boolean') throw invalid('featured must be a boolean');
    const rank = body.rank;
    if (rank !== undefined && rank !== null && (!Number.isInteger(rank) || (rank as number) < 1 || (rank as number) > FEATURED_RANK_MAX))
      throw invalid(`rank must be an integer in 1..${FEATURED_RANK_MAX}, or null`);
    if (!body.featured && rank !== undefined && rank !== null) throw invalid('rank needs featured: true');
    const r = await this.record(id);
    if (r.status !== 'approved') throw conflict(`only approved artworks can be featured (artwork is ${r.status})`, { status: r.status });
    void reviewerId;
    const now = this.now();
    const featuredRank = !body.featured ? null : rank === undefined ? (r.featuredRank ?? null) : (rank as number | null);
    const next = await this.d.artworks.save({ ...r, featured: body.featured, featuredAt: body.featured ? (r.featuredAt ?? now) : null, featuredRank, updatedAt: now });
    return this.toPublic(next, true);
  }

  // ------------------------------------------------------------------ royalties

  async recordRoyalty(body: unknown): Promise<{ record: RoyaltyRecord; created: boolean }> {
    if (!isObject(body)) throw invalid('body must be a JSON object');
    const orderId = typeof body.orderId === 'string' && ORDER_ID_RE.test(body.orderId) ? body.orderId : null;
    if (!orderId) throw invalid('orderId must match ^[A-Za-z0-9_-]{1,64}$');
    const artworkId = typeof body.artworkId === 'string' && ARTWORK_ID.test(body.artworkId) ? body.artworkId : null;
    if (!artworkId) throw invalid('artworkId must match ^[A-Za-z0-9_-]{1,64}$');
    const minterAddress = text(body.minterAddress, 'minterAddress', 90);
    const royaltySats = body.royaltySats;
    if (!Number.isInteger(royaltySats) || (royaltySats as number) < 0) throw invalid('royaltySats must be a non-negative integer');
    const fundingTxid = typeof body.fundingTxid === 'string' ? body.fundingTxid.toLowerCase() : '';
    if (!isSha256Hex(fundingTxid)) throw invalid('fundingTxid must be 64 hex characters');
    const vout = body.vout;
    if (!Number.isInteger(vout) || (vout as number) < 0) throw invalid('vout must be a non-negative integer');
    const at = typeof body.at === 'string' && Number.isFinite(Date.parse(body.at)) ? new Date(body.at).toISOString() : null;
    if (!at) throw invalid('at must be an ISO 8601 timestamp');
    const edition = body.edition;
    if (edition !== undefined && (!Number.isInteger(edition) || (edition as number) < 1)) throw invalid('edition must be a positive integer');
    const artwork = await this.d.artworks.get(artworkId);
    if (!artwork) throw notFound('artwork');
    const record: RoyaltyRecord = {
      orderId,
      artworkId,
      artist: artwork.artist,
      minterAddress,
      royaltySats: royaltySats as number,
      fundingTxid,
      vout: vout as number,
      at,
      recordedAt: this.now(),
      ...(edition !== undefined ? { edition: edition as number } : {}),
    };
    const existing = await this.d.royalties.getByOrder(orderId);
    if (existing) {
      if (sameRoyaltyFacts(existing, record)) return { record: existing, created: false };
      throw conflict(`order ${orderId} was already recorded with different facts`, { existing });
    }
    await this.d.royalties.create(record);
    const updated = await this.refreshMintedEditions(artworkId);
    this.notifyArtist(record.artist, royaltyNotification(record, (updated ?? artwork).title), `royalty:${orderId}`);
    return { record, created: true };
  }

  /**
   * mintedEditions := the artwork's royalty records (ADR-0012). Recomputed from the store rather than
   * incremented, so a retry after a concurrent write converges instead of double counting.
   */
  private async refreshMintedEditions(artworkId: string): Promise<ArtworkRecord | null> {
    for (let attempt = 0; attempt < MINTED_REFRESH_ATTEMPTS; attempt++) {
      const r = await this.d.artworks.get(artworkId);
      if (!r) return null;
      const minted = await this.d.royalties.countByArtwork(artworkId);
      if ((r.mintedEditions ?? 0) === minted) return r;
      try {
        return await this.d.artworks.save({ ...r, mintedEditions: minted, updatedAt: this.now() });
      } catch (e) {
        if (!(e instanceof StaleWriteError)) throw e;
      }
    }
    this.log.warn('mintedEditions not refreshed after concurrent writes; the next royalty record recomputes it', { artworkId });
    return null;
  }

  async royalties(address: string, raw: { page?: unknown; pageSize?: unknown }): Promise<RoyaltiesResult> {
    await this.artistRecord(address);
    const { page, pageSize } = parsePage(raw);
    const res = await this.d.royalties.listByArtist(address, page, pageSize);
    return { items: res.items, totals: res.totals, page, pageSize, total: res.total };
  }
}
