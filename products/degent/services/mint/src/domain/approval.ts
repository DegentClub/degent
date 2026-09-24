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
import { canonicalAddress } from './address.js';

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
 * Degents the voter holds that have not backed a vote on this order yet. Each vote is backed by a
 * distinct Degent: moving a Degent that already voted to a fresh address does not buy a second vote.
 */
export function unusedDegents(voterDegents: readonly number[], existing: readonly VoteRecord[]): number[] {
  const used = new Set(existing.map((v) => v.voterDegent));
  return voterDegents.filter((n) => !used.has(n));
}

/**
 * Everything except the signature: the order is open for review, the voter holds a Degent that has not
 * voted on this order yet, is not the recipient, has not voted yet (addresses compared in their canonical
 * spelling), and the statement is exactly what we expect for this order.
 */
export function checkVote(i: VoteCheckInput): VoteRejection | null {
  if (i.order.status !== 'member_review')
    return { code: 'review_closed', message: `order is not open for member review (status ${i.order.status})` };
  if (i.voterDegents.length === 0) return { code: 'not_a_holder', message: 'this address holds no Degent' };
  const voter = canonicalAddress(i.voterAddress);
  if (voter === canonicalAddress(i.order.recipientAddress)) return { code: 'self_vote', message: 'a member cannot vote on their own order' };
  if (i.existing.some((v) => canonicalAddress(v.voterAddress) === voter)) return { code: 'already_voted', message: 'this address has already voted on this order' };
  if (unusedDegents(i.voterDegents, i.existing).length === 0) {
    const held = [...i.voterDegents].sort((a, b) => a - b).map((n) => `#${n}`).join(', ');
    return { code: 'already_voted', message: `every Degent this address holds (Degent ${held}) has already voted on this order` };
  }
  const expected = voteStatement(i.vote, i.order.id, voteReference(i.order));
  if (i.message !== expected) {
    const parsed = parseVoteStatement(i.message);
    const why = !parsed ? 'message is not a vote statement' : parsed.vote !== i.vote ? 'message vote differs from the vote field' : parsed.orderId !== i.order.id ? 'message names another order' : 'message references different content';
    return { code: 'vote_invalid', message: `${why}; expected "${expected}"` };
  }
  return null;
}

/**
 * The voter's membership identity for the public record: their lowest-numbered Degent that has not voted
 * on this order yet (`existing` omitted: the lowest they hold).
 */
export function votingDegent(degents: readonly number[], existing: readonly VoteRecord[] = []): number {
  return Math.min(...unusedDegents(degents, existing));
}

/** Degent number for the order approved with `rank` (1 = the first approved order). */
export function degentNumberForRankOf(rank: number, cfg: Pick<ApprovalConfig, 'gallerySize'>): number {
  return degentNumberForRank(rank, cfg.gallerySize);
}

/** Degent number for the next approved order given how many were approved before it. */
export function nextDegentNumber(approvedSoFar: number, cfg: Pick<ApprovalConfig, 'gallerySize'>): number {
  return degentNumberForRank(approvedSoFar + 1, cfg.gallerySize);
}
