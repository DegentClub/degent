/**
 * Member approval (ADR-0007). Pure rules: who may vote, when a quorum is reached, how a Degent
 * number is assigned. Every new Degent must be approved by existing members before the
 * parent-linked reveal; approval IS membership because the parent link is applied at reveal.
 *
 * Signature verification (BIP-322 via @bsh/identity) happens in the application layer so this file
 * stays free of I/O and crypto; it receives already-checked facts.
 */
import type { ApprovalInfo, VoteChoice } from '@bsh/degent-mint-sdk';
import { degentNumberForRank, parseVoteStatement, voteReference, voteStatement } from '@bsh/degent-mint-sdk';
import type { OrderRecord } from './order.js';

export interface VoteRecord {
  orderId: string;
  voterAddress: string;
  /** The Degent the voter voted with (lowest number they hold at vote time). */
  voterDegent: number;
  vote: VoteChoice;
  at: string;
  /** BIP-322 simple signature (base64) over `message`. */
  signature: string;
  message: string;
}

export interface ApprovalConfig {
  approvalQuorum: number;
  declineQuorum: number;
  /** member_review -> rescue_available after this long without a decision. */
  reviewSlaSeconds: number;
  /** Numbers already taken by the Gallery: the first approved order gets gallerySize + 1. */
  gallerySize: number;
}

export interface Tally {
  approvals: number;
  declines: number;
}

export function tally(votes: readonly VoteRecord[]): Tally {
  let approvals = 0;
  let declines = 0;
  for (const v of votes) if (v.vote === 'approve') approvals++; else declines++;
  return { approvals, declines };
}

export type Verdict = 'approved' | 'declined' | 'open';

/** Approval quorum wins ties by construction: it is checked first. */
export function verdict(t: Tally, cfg: Pick<ApprovalConfig, 'approvalQuorum' | 'declineQuorum'>): Verdict {
  if (t.approvals >= cfg.approvalQuorum) return 'approved';
  if (t.declines >= cfg.declineQuorum) return 'declined';
  return 'open';
}

export function reviewDeadline(reviewStartedAt: string, cfg: Pick<ApprovalConfig, 'reviewSlaSeconds'>): string {
  return new Date(Date.parse(reviewStartedAt) + cfg.reviewSlaSeconds * 1000).toISOString();
}

export function approvalInfo(r: Pick<OrderRecord, 'reviewStartedAt'>, votes: readonly VoteRecord[], cfg: ApprovalConfig): ApprovalInfo {
  const t = tally(votes);
  return {
    approvals: t.approvals,
    declines: t.declines,
    approvalQuorum: cfg.approvalQuorum,
    declineQuorum: cfg.declineQuorum,
    reviewStartedAt: r.reviewStartedAt,
    reviewDeadline: r.reviewStartedAt ? reviewDeadline(r.reviewStartedAt, cfg) : null,
  };
}

export type VoteRejection =
  | { code: 'review_closed'; message: string }
  | { code: 'not_a_holder'; message: string }
  | { code: 'self_vote'; message: string }
  | { code: 'already_voted'; message: string }
  | { code: 'vote_invalid'; message: string };

export interface VoteCheckInput {
  order: Pick<OrderRecord, 'id' | 'status' | 'recipientAddress' | 'inscriptionId' | 'contentSha256'>;
  voterAddress: string;
  /** Degents the voter holds right now (re-checked at vote time, not taken from the session). */
  voterDegents: readonly number[];
  vote: VoteChoice;
  message: string;
  existing: readonly VoteRecord[];
}

/**
 * Everything except the signature: the order is open for review, the voter holds a Degent, is not
 * the recipient, has not voted yet, and the statement is exactly what we expect for this order.
 */
export function checkVote(i: VoteCheckInput): VoteRejection | null {
  if (i.order.status !== 'member_review')
    return { code: 'review_closed', message: `order is not open for member review (status ${i.order.status})` };
  if (i.voterDegents.length === 0) return { code: 'not_a_holder', message: 'this address holds no Degent' };
  if (i.voterAddress === i.order.recipientAddress) return { code: 'self_vote', message: 'a member cannot vote on their own order' };
  if (i.existing.some((v) => v.voterAddress === i.voterAddress)) return { code: 'already_voted', message: 'this address has already voted on this order' };
  const expected = voteStatement(i.vote, i.order.id, voteReference(i.order));
  if (i.message !== expected) {
    const parsed = parseVoteStatement(i.message);
    const why = !parsed ? 'message is not a vote statement' : parsed.vote !== i.vote ? 'message vote differs from the vote field' : parsed.orderId !== i.order.id ? 'message names another order' : 'message references different content';
    return { code: 'vote_invalid', message: `${why}; expected "${expected}"` };
  }
  return null;
}

/** The voter's membership identity for the public record: their lowest-numbered Degent. */
export function votingDegent(degents: readonly number[]): number {
  return Math.min(...degents);
}

/** Degent number for the next approved order given how many were approved before it. */
export function nextDegentNumber(approvedSoFar: number, cfg: Pick<ApprovalConfig, 'gallerySize'>): number {
  return degentNumberForRank(approvedSoFar + 1, cfg.gallerySize);
}
