/**
 * Member approval (ADR-0007): holder sign-in with SIWB (@bsh/identity), the review queue, and
 * BIP-322-signed votes that move an order from member_review to queued (approval quorum, Degent
 * number assigned) or declined (decline quorum). Signature and nonce checks are the platform's;
 * this file only wires them to orders and holders.
 */
import {
  InMemoryNonceStore,
  issueChallenge,
  SessionError,
  SessionKeyRing,
  verifyBip322Simple,
  verifySignIn,
  type NonceStore,
  type SessionClaims,
  type SigningKey,
} from '@bsh/identity';
import type { AuthChallengeResponse, AuthVerifyResponse, CastVoteRequest, ReviewQueueResponse, VoteChoice, VotesResponse } from '@bsh/degent-mint-sdk';
import { addressKind } from '../domain/address.js';
import { approvalInfo, checkVote, nextDegentNumber, tally, verdict, votingDegent, type VoteRecord } from '../domain/approval.js';
import { DomainError, invalid, notFound } from '../domain/errors.js';
import { IN_MEMBER_REVIEW, type OrderRecord } from '../domain/order.js';
import type { Clock } from '../ports/clock.js';
import type { HolderRegistry } from '../ports/holder-registry.js';
import type { OrderStore } from '../ports/order-store.js';
import type { VoteStore } from '../ports/vote-store.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { OrderService } from './order-service.js';

export interface ApprovalServiceDeps {
  orders: OrderService;
  store: OrderStore;
  votes: VoteStore;
  holders: HolderRegistry;
  clock: Clock;
  sessionKey: SigningKey;
  /** Public keys still accepted after a rotation. */
  previousKeys?: ConstructorParameters<typeof SessionKeyRing>[1];
  nonces?: NonceStore;
  log?: Logger;
}

export const MEMBER_SCOPE = 'member';

export interface HolderSession {
  address: string;
  degents: number[];
  claims: SessionClaims;
}

export class ApprovalService {
  private readonly keys: SessionKeyRing;
  private readonly nonces: NonceStore;
  private readonly log: Logger;

  constructor(private readonly d: ApprovalServiceDeps) {
    this.keys = new SessionKeyRing(d.sessionKey, d.previousKeys ?? []);
    this.nonces = d.nonces ?? new InMemoryNonceStore();
    this.log = d.log ?? silentLogger;
  }

  private get s() {
    return this.d.orders.settings;
  }

  /** JWKS of the session keys (for other services that want to verify holder sessions). */
  jwks() {
    return this.keys.jwks();
  }

  // ---------------------------------------------------------------- sign-in

  async challenge(body: unknown): Promise<AuthChallengeResponse> {
    const o = asObject(body, ['address']);
    const address = o.address;
    if (typeof address !== 'string' || addressKind(address, this.s.network) === null) throw invalid(`address is not a valid ${this.s.network} address`);
    const auth = this.s.auth;
    const ch = await issueChallenge(this.nonces, {
      domain: auth.domain,
      ...(auth.uri ? { uri: auth.uri } : {}),
      address,
      network: this.s.network,
      ttlSeconds: auth.challengeTtlSeconds,
      statement: 'Sign in to degent.club as a club member. This request will not trigger a transaction or cost any fees.',
      now: this.d.clock.now(),
    });
    return { message: ch.message, expiresAt: ch.fields.expirationTime };
  }

  async verify(body: unknown): Promise<AuthVerifyResponse> {
    const o = asObject(body, ['address', 'message', 'signature']);
    for (const k of ['address', 'message', 'signature'] as const) if (typeof o[k] !== 'string') throw invalid(`${k} must be a string`);
    const r = await verifySignIn(
      { address: o.address as string, message: o.message as string, signature: o.signature as string },
      { domain: this.s.auth.domain, nonces: this.nonces, network: this.s.network, now: this.d.clock.now() },
    );
    if (!r.ok) {
      this.log.warn('holder sign-in refused', { error: r.error, detail: r.detail });
      throw new DomainError('auth_failed', 401, `sign-in failed: ${r.error}`);
    }
    const { degents } = await this.d.holders.isHolder(r.address);
    if (degents.length === 0) throw new DomainError('not_a_holder', 403, 'this address holds no Degent; only club members can review');
    const ttl = this.s.auth.sessionTtlSeconds;
    const now = this.d.clock.now();
    const token = this.keys.issue(
      { sub: r.address, accounts: [r.address], product: this.s.auth.audience, scopes: [MEMBER_SCOPE] },
      { ttlSeconds: ttl, now },
    );
    return { token, address: r.address, degents, expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
  }

  /** Bearer holder session -> address + the Degents held RIGHT NOW (a sold Degent revokes the vote right). */
  async authorizeHolder(authorization: string | undefined | null): Promise<HolderSession> {
    const m = /^Bearer\s+([A-Za-z0-9_.-]{16,8192})\s*$/.exec(authorization ?? '');
    if (!m) throw new DomainError('unauthorized', 401, 'missing or malformed holder session (Authorization: Bearer <token>)');
    let claims: SessionClaims;
    try {
      claims = this.keys.verify(m[1]!, { audience: this.s.auth.audience, requiredScopes: [MEMBER_SCOPE], now: this.d.clock.now() });
    } catch (e) {
      const code = e instanceof SessionError ? e.code : 'invalid';
      throw new DomainError('unauthorized', 401, `holder session rejected: ${code}`);
    }
    const { degents } = await this.d.holders.isHolder(claims.sub);
    if (degents.length === 0) throw new DomainError('not_a_holder', 403, 'this address no longer holds a Degent');
    return { address: claims.sub, degents, claims };
  }

  // ---------------------------------------------------------------- review queue and votes

  async reviewQueue(session: HolderSession): Promise<ReviewQueueResponse> {
    const rows = await this.d.store.listByStatus(IN_MEMBER_REVIEW);
    const mine = new Map((await this.d.votes.listByVoter(session.address)).map((v) => [v.orderId, v.vote]));
    const items = [];
    for (const r of rows) {
      const votes = await this.d.votes.listByOrder(r.id);
      items.push({
        order: await this.d.orders.publicOrder(r),
        approval: approvalInfo(r, votes, this.s.approval),
        voted: mine.get(r.id) ?? null,
      });
    }
    return { items, memberDegents: session.degents };
  }

  async votes(orderId: string): Promise<VotesResponse> {
    const r = await this.d.store.get(orderId);
    if (!r) throw notFound('order');
    return this.votesOf(r, await this.d.votes.listByOrder(r.id));
  }

  private votesOf(r: OrderRecord, votes: VoteRecord[]): VotesResponse {
    return {
      orderId: r.id,
      status: r.status,
      approval: approvalInfo(r, votes, this.s.approval),
      votes: votes.map((v) => ({ degent: v.voterDegent, vote: v.vote, at: v.at, signature: v.signature, message: v.message })),
    };
  }

  async castVote(orderId: string, session: HolderSession, body: unknown): Promise<VotesResponse> {
    const req = parseCastVote(body);
    const r = await this.d.store.get(orderId);
    if (!r) throw notFound('order');
    const existing = await this.d.votes.listByOrder(r.id);
    const rejection = checkVote({ order: r, voterAddress: session.address, voterDegents: session.degents, vote: req.vote, message: req.message, existing });
    if (rejection) {
      const status = rejection.code === 'review_closed' || rejection.code === 'already_voted' ? 409 : rejection.code === 'vote_invalid' ? 422 : 403;
      throw new DomainError(rejection.code, status, rejection.message);
    }
    // The vote is a BIP-322 simple signature of the statement by the session address: independently verifiable.
    const sig = verifyBip322Simple(session.address, this.s.network, req.message, req.signature);
    if (!sig.valid) throw new DomainError('vote_invalid', 422, `vote signature rejected: ${sig.reason}`);

    const vote: VoteRecord = {
      orderId: r.id,
      voterAddress: session.address,
      voterDegent: votingDegent(session.degents),
      vote: req.vote,
      at: this.d.clock.now().toISOString(),
      signature: req.signature,
      message: req.message,
    };
    try {
      await this.d.votes.add(vote);
    } catch {
      throw new DomainError('already_voted', 409, 'this address has already voted on this order');
    }
    const all = [...existing, vote];
    const t = tally(all);
    const outcome = verdict(t, this.s.approval);
    let saved: OrderRecord = r;
    if (outcome === 'approved') {
      const count = await this.d.orders.approvedCount();
      const degentNumber = nextDegentNumber(count, this.s.approval);
      const at = vote.at;
      saved = await this.d.orders.transition(r, 'queued', {
        detail: `approved by ${t.approvals} members; Degent #${degentNumber}`,
        patch: { degentNumber, approvedAt: at, queuedAt: at },
      });
      await this.d.orders.setApprovedCount(count + 1);
      this.log.info('order approved by members', { orderId: r.id, degentNumber, approvals: t.approvals });
    } else if (outcome === 'declined') {
      saved = await this.d.orders.transition(r, 'declined', {
        detail: `declined by ${t.declines} members; self-rescue (no parent) is available`,
      });
      this.log.info('order declined by members', { orderId: r.id, declines: t.declines });
    }
    return this.votesOf(saved, all);
  }
}

// ------------------------------------------------------------------ parsing

function asObject(body: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new DomainError('bad_request', 400, 'JSON object body required');
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) throw invalid(`unknown field(s): ${unknown.join(', ')}`);
  return body as Record<string, unknown>;
}

export function parseCastVote(body: unknown): CastVoteRequest {
  const o = asObject(body, ['vote', 'message', 'signature']);
  const errors: string[] = [];
  if (o.vote !== 'approve' && o.vote !== 'decline') errors.push('vote must be "approve" or "decline"');
  if (typeof o.message !== 'string' || o.message.length === 0 || o.message.length > 280) errors.push('message must be a string of at most 280 characters');
  if (typeof o.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.signature) || o.signature.length > 512) errors.push('signature must be base64 (max 512 chars)');
  if (errors.length) throw invalid(errors.join('; '), { errors });
  return { vote: o.vote as VoteChoice, message: o.message as string, signature: o.signature as string };
}
