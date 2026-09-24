/**
 * The holders-only Telegram gate (ADR-0007 follow-up 4, roadmap p3.6). Everything external is a port:
 *
 *   /verify (DM)          startVerification(tg)   -> one-time link <WEB_BASE_URL>/verify?tg=<token>
 *   POST /gate/challenge  challenge(body)         -> SIWB challenge (@bsh/identity issueChallenge), statement names tg
 *   POST /gate/verify     verify(body)            -> verifySignIn + Register holder check -> single-use invite by DM
 *   scheduler             reverifyAll()           -> kicks (ban + unban) members whose wallet no longer holds a Degent
 *   GET  /gate/stats      stats()                 -> behind an operator session (SIWB, ADMIN_ADDRESSES)
 *
 * Rules: one wallet <-> one Telegram account (among active members); a link works once; the invite has
 * member_limit=1 and expires in 10 minutes and is only ever sent by DM; a Register error never kicks anyone.
 */
import {
  issueChallenge,
  parseSiwbMessage,
  SessionError,
  verifySignIn,
  type BitcoinNetwork,
  type NonceStore,
  type SessionClaims,
  type SessionKeyRing,
  type SiwbFields,
} from '@bsh/identity';
import { addressKey, isVerifiableAddress } from '../domain/address.js';
import { GateError } from '../domain/errors.js';
import { isTelegramUserId, signLinkToken, verifyLinkToken, type LinkClaims } from '../domain/link-token.js';
import { MESSAGES } from '../domain/messages.js';
import { SlidingWindowLimiter } from '../domain/rate-limit.js';
import { ADMIN_STATEMENT, gateStatement } from '../domain/statement.js';
import type { HolderRegistry } from '../ports/holder-registry.js';
import type { MemberStats, MemberStore } from '../ports/member-store.js';
import type { TelegramApi } from '../ports/telegram-api.js';
import { silentLogger, type Logger } from './logger.js';

export interface GateSettings {
  network: BitcoinNetwork;
  /** The private holders group, e.g. -1001234567890. */
  holdersChatId: string;
  /** Origin (+ optional path) of the site that serves /verify, no trailing slash. */
  webBaseUrl: string;
  /** SIWB domain (host[:port] of webBaseUrl) and URI the challenge is bound to. */
  siwbDomain: string;
  siwbUri: string;
  linkSecret: string;
  linkTtlSeconds: number;
  inviteTtlSeconds: number;
  verifyRateLimit: { max: number; windowMs: number };
  /** Addresses allowed to sign in as operators (GET /gate/stats). */
  adminAddresses: string[];
  sessionTtlSeconds: number;
}

export const DEFAULT_SETTINGS = {
  linkTtlSeconds: 600,
  inviteTtlSeconds: 600,
  verifyRateLimit: { max: 3, windowMs: 10 * 60 * 1000 },
  sessionTtlSeconds: 3600,
} as const;

export const SESSION_AUDIENCE = 'degent-telegram-gate';
export const ADMIN_SCOPE = 'gate:admin';

export interface GateServiceDeps {
  settings: GateSettings;
  members: MemberStore;
  holders: HolderRegistry;
  telegram: TelegramApi;
  nonces: NonceStore;
  sessions: SessionKeyRing;
  /** Epoch ms. */
  now?: () => number;
  log?: Logger;
}

export interface ChallengeResponse {
  message: string;
  expiresAt: string;
}

export interface VerifyResponse {
  ok: true;
  degents: number[];
  message: string;
}

export interface ReverifyResult {
  checked: number;
  kept: number[];
  kicked: number[];
  errors: Array<{ telegramUserId: number; error: string }>;
  kickFailures: number[];
  at: string;
}

export interface ReverifySummary {
  at: string;
  checked: number;
  kept: number;
  kicked: number;
  errors: number;
  kickFailures: number;
}

export interface GateStats extends MemberStats {
  lastReverify: ReverifySummary | null;
}

type Body = Record<string, unknown>;

function asObject(body: unknown, keys: readonly string[]): Record<string, string> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new GateError('bad_request', 400, 'body must be a JSON object');
  const o = body as Body;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== 'string' || v.length === 0) throw new GateError('bad_request', 400, `${k} must be a non-empty string`);
    if (v.length > 4096) throw new GateError('bad_request', 400, `${k} is too long`);
    out[k] = v;
  }
  return out;
}

export class GateService {
  private readonly s: GateSettings;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly verifyLimiter: SlidingWindowLimiter;
  private readonly admins: Set<string>;
  private last: ReverifyResult | null = null;

  constructor(private readonly d: GateServiceDeps) {
    this.s = d.settings;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? silentLogger;
    this.verifyLimiter = new SlidingWindowLimiter(this.s.verifyRateLimit.max, this.s.verifyRateLimit.windowMs);
    this.admins = new Set(this.s.adminAddresses.map(addressKey));
  }

  // ------------------------------------------------------------------ 1. /verify in a DM

  async startVerification(telegramUserId: unknown): Promise<{ url: string; token: string; text: string }> {
    if (!isTelegramUserId(telegramUserId)) throw new GateError('bad_telegram_id', 400, 'invalid telegram user id');
    if (!this.verifyLimiter.hit(String(telegramUserId), this.now())) throw new GateError('rate_limited', 429, MESSAGES.rateLimited);
    const token = signLinkToken(telegramUserId, { secret: this.s.linkSecret, ttlSeconds: this.s.linkTtlSeconds, now: this.now() });
    const url = `${this.s.webBaseUrl}/verify?tg=${encodeURIComponent(token)}`;
    return { url, token, text: MESSAGES.linkIntro(url, Math.round(this.s.linkTtlSeconds / 60)) };
  }

  // ------------------------------------------------------------------ 2. POST /gate/challenge

  async challenge(body: unknown): Promise<ChallengeResponse> {
    const o = asObject(body, ['token', 'address']);
    const link = this.readToken(o.token!);
    const address = this.readAddress(o.address!);
    await this.assertNotTaken(link.tg, address);
    // The challenge cannot outlive the link it came from.
    const ttl = Math.max(1, Math.min(this.s.linkTtlSeconds, link.exp - Math.floor(this.now() / 1000)));
    const ch = await issueChallenge(this.d.nonces, {
      domain: this.s.siwbDomain,
      uri: this.s.siwbUri,
      address,
      network: this.s.network,
      ttlSeconds: ttl,
      statement: gateStatement(link.tg),
      now: this.now(),
    });
    return { message: ch.message, expiresAt: ch.fields.expirationTime };
  }

  // ------------------------------------------------------------------ 3-5. POST /gate/verify

  async verify(body: unknown): Promise<VerifyResponse> {
    const o = asObject(body, ['token', 'address', 'message', 'signature']);
    const link = this.readToken(o.token!);
    const address = this.readAddress(o.address!);

    // Bind the signed text to this link's Telegram account BEFORE any nonce is consumed.
    let fields: SiwbFields;
    try {
      fields = parseSiwbMessage(o.message!);
    } catch {
      throw new GateError('bad_message', 400, 'message is not a gate challenge');
    }
    if (fields.statement !== gateStatement(link.tg)) throw new GateError('bad_message', 400, 'message is for a different Telegram account');
    if (fields.address !== address) throw new GateError('bad_message', 400, 'message is for a different address');

    await this.assertNotTaken(link.tg, address);

    const r = await verifySignIn(
      { address, message: o.message!, signature: o.signature! },
      { domain: this.s.siwbDomain, nonces: this.d.nonces, network: this.s.network, now: this.now() },
    );
    if (!r.ok) {
      this.log.warn('gate: sign-in refused', { telegramUserId: link.tg, error: r.error });
      throw new GateError('auth_failed', 401, `signature not accepted: ${r.error}`);
    }

    if (!(await this.d.members.consumeLink(link.jti, link.exp * 1000, this.now())))
      throw new GateError('bad_token', 401, 'this /verify link was already used; send /verify again');

    let degents: number[];
    try {
      degents = await this.d.holders.getHoldings(address, { fresh: true });
    } catch (e) {
      this.log.error('gate: holder check failed', { telegramUserId: link.tg, error: e instanceof Error ? e.message : String(e) });
      throw new GateError('upstream_unavailable', 503, 'the Register is unavailable; send /verify again in a few minutes');
    }
    if (degents.length === 0) throw new GateError('not_a_holder', 403, 'this address does not hold a Degent');

    const at = new Date(this.now()).toISOString();
    await this.d.members.upsertVerified({ telegramUserId: link.tg, address, degents, at });

    // Exactly one invite per successful verification, delivered only by DM.
    let invite: string;
    try {
      invite = (
        await this.d.telegram.createInviteLink(this.s.holdersChatId, {
          memberLimit: 1,
          expireDate: Math.floor(this.now() / 1000) + this.s.inviteTtlSeconds,
          name: `gate:${link.tg}`,
        })
      ).inviteLink;
    } catch (e) {
      this.log.error('gate: createChatInviteLink failed', { telegramUserId: link.tg, error: e instanceof Error ? e.message : String(e) });
      throw new GateError('upstream_unavailable', 503, 'Telegram did not issue an invite; send /verify again in a few minutes');
    }
    await this.d.members.recordInvite(link.tg, at);
    let dmOk = true;
    try {
      await this.d.telegram.sendMessage(link.tg, MESSAGES.welcome(invite, degents.length, Math.round(this.s.inviteTtlSeconds / 60)));
    } catch (e) {
      dmOk = false;
      this.log.warn('gate: could not DM the invite', { telegramUserId: link.tg, error: e instanceof Error ? e.message : String(e) });
    }
    this.log.info('gate: member verified', { telegramUserId: link.tg, degents: degents.length });
    return { ok: true, degents, message: dmOk ? MESSAGES.verifiedWeb : MESSAGES.verifiedWebNoDm };
  }

  // ------------------------------------------------------------------ 6. periodic re-verification

  async reverifyAll(): Promise<ReverifyResult> {
    const result: ReverifyResult = { checked: 0, kept: [], kicked: [], errors: [], kickFailures: [], at: new Date(this.now()).toISOString() };

    // Kicks that failed on an earlier run (Telegram error) are retried first.
    for (const m of await this.d.members.listKickPending()) if (!(await this.kick(m.telegramUserId))) result.kickFailures.push(m.telegramUserId);

    for (const m of await this.d.members.listActive()) {
      result.checked++;
      let degents: number[];
      try {
        degents = await this.d.holders.getHoldings(m.address, { fresh: true });
      } catch (e) {
        // Never kick on a Register failure: keep the member and try again next run.
        const error = e instanceof Error ? e.message : String(e);
        result.errors.push({ telegramUserId: m.telegramUserId, error });
        this.log.warn('gate: holder check failed, keeping member', { telegramUserId: m.telegramUserId, error });
        continue;
      }
      const at = new Date(this.now()).toISOString();
      if (degents.length > 0) {
        await this.d.members.updateHoldings(m.telegramUserId, degents, at);
        result.kept.push(m.telegramUserId);
        continue;
      }
      await this.d.members.revoke(m.telegramUserId, at);
      result.kicked.push(m.telegramUserId);
      if (!(await this.kick(m.telegramUserId))) result.kickFailures.push(m.telegramUserId);
      try {
        await this.d.telegram.sendMessage(m.telegramUserId, MESSAGES.revoked(m.address));
      } catch (e) {
        this.log.warn('gate: could not DM a revoked member', { telegramUserId: m.telegramUserId, error: e instanceof Error ? e.message : String(e) });
      }
      this.log.info('gate: member revoked', { telegramUserId: m.telegramUserId });
    }
    this.last = result;
    this.log.info('gate: re-verification complete', {
      checked: result.checked,
      kept: result.kept.length,
      kicked: result.kicked.length,
      errors: result.errors.length,
      kickFailures: result.kickFailures.length,
    });
    return result;
  }

  /** Ban + unban removes the member but lets them rejoin later with a new invite. */
  private async kick(telegramUserId: number): Promise<boolean> {
    try {
      await this.d.telegram.banChatMember(this.s.holdersChatId, telegramUserId);
      await this.d.telegram.unbanChatMember(this.s.holdersChatId, telegramUserId, { onlyIfBanned: true });
      await this.d.members.markKicked(telegramUserId);
      return true;
    } catch (e) {
      this.log.error('gate: kick failed, will retry next run', { telegramUserId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  // ------------------------------------------------------------------ 7. operators

  async stats(): Promise<GateStats> {
    const base = await this.d.members.stats();
    const l = this.last;
    return {
      ...base,
      lastReverify: l ? { checked: l.checked, kept: l.kept.length, kicked: l.kicked.length, errors: l.errors.length, kickFailures: l.kickFailures.length, at: l.at } : null,
    };
  }

  async adminChallenge(body: unknown): Promise<ChallengeResponse> {
    const o = asObject(body, ['address']);
    const address = this.readAddress(o.address!);
    if (!this.admins.has(addressKey(address))) throw new GateError('forbidden', 403, 'this address is not a gate operator');
    const ch = await issueChallenge(this.d.nonces, {
      domain: this.s.siwbDomain,
      uri: this.s.siwbUri,
      address,
      network: this.s.network,
      ttlSeconds: 300,
      statement: ADMIN_STATEMENT,
      now: this.now(),
    });
    return { message: ch.message, expiresAt: ch.fields.expirationTime };
  }

  async adminVerify(body: unknown): Promise<{ token: string; expiresAt: string }> {
    const o = asObject(body, ['address', 'message', 'signature']);
    const address = this.readAddress(o.address!);
    if (!this.admins.has(addressKey(address))) throw new GateError('forbidden', 403, 'this address is not a gate operator');
    let fields: SiwbFields;
    try {
      fields = parseSiwbMessage(o.message!);
    } catch {
      throw new GateError('bad_message', 400, 'message is not an operator challenge');
    }
    if (fields.statement !== ADMIN_STATEMENT) throw new GateError('bad_message', 400, 'message is not an operator challenge');
    const r = await verifySignIn(
      { address, message: o.message!, signature: o.signature! },
      { domain: this.s.siwbDomain, nonces: this.d.nonces, network: this.s.network, now: this.now() },
    );
    if (!r.ok) throw new GateError('auth_failed', 401, `signature not accepted: ${r.error}`);
    const now = new Date(this.now());
    const token = this.d.sessions.issue(
      { sub: address, accounts: [address], product: SESSION_AUDIENCE, scopes: [ADMIN_SCOPE] },
      { ttlSeconds: this.s.sessionTtlSeconds, now },
    );
    return { token, expiresAt: new Date(now.getTime() + this.s.sessionTtlSeconds * 1000).toISOString() };
  }

  /** `Authorization: Bearer <session>` -> claims, for an address still on the operator list. */
  authorizeAdmin(authorization: string | null | undefined): SessionClaims {
    const m = /^Bearer\s+([A-Za-z0-9_.-]{16,8192})\s*$/.exec(authorization ?? '');
    if (!m) throw new GateError('unauthorized', 401, 'missing or malformed operator session (Authorization: Bearer <token>)');
    let claims: SessionClaims;
    try {
      claims = this.d.sessions.verify(m[1]!, { audience: SESSION_AUDIENCE, requiredScopes: [ADMIN_SCOPE], now: new Date(this.now()) });
    } catch (e) {
      throw new GateError('unauthorized', 401, `operator session rejected: ${e instanceof SessionError ? e.code : 'invalid'}`);
    }
    if (!this.admins.has(addressKey(claims.sub))) throw new GateError('forbidden', 403, 'this address is no longer a gate operator');
    return claims;
  }

  // ------------------------------------------------------------------ helpers

  private readToken(token: string): LinkClaims {
    const r = verifyLinkToken(token, { secret: this.s.linkSecret, now: this.now() });
    if (!r.ok) throw new GateError('bad_token', 401, r.reason === 'expired' ? 'this /verify link expired; send /verify again' : 'invalid /verify link');
    return r.claims;
  }

  private readAddress(address: string): string {
    if (!isVerifiableAddress(address, this.s.network)) throw new GateError('bad_address', 400, `address is not a ${this.s.network} address the gate can verify`);
    return address;
  }

  private async assertNotTaken(telegramUserId: number, address: string): Promise<void> {
    const byAddress = await this.d.members.findActiveByAddress(address);
    if (byAddress && byAddress.telegramUserId !== telegramUserId)
      throw new GateError('address_taken', 409, 'this wallet is already linked to another Telegram account');
    const byTg = await this.d.members.findByTelegramId(telegramUserId);
    if (byTg && byTg.status === 'active' && addressKey(byTg.address) !== addressKey(address))
      throw new GateError('telegram_taken', 409, `this Telegram account is already linked to wallet ${byTg.address}`);
  }
}
