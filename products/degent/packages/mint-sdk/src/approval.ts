/**
 * Member approval rules shared by the browser (what the wallet signs) and the service (what it
 * verifies). One implementation of the statement text; the service rebuilds it and compares.
 */
import type { Order, VoteChoice } from './types.js';

/** First 4,112 Degents are the Gallery; approved mints number from 4113 (ADR-0005 §4). */
export const GALLERY_SIZE = 4112;
export const CHARTER_SIZE = 10_000;
export const DEFAULT_APPROVAL_QUORUM = 3;
export const DEFAULT_DECLINE_QUORUM = 3;
/** Review SLA after which self-rescue is offered instead of a member decision (14 days). */
export const DEFAULT_REVIEW_SLA_SECONDS = 14 * 86_400;

/** The reference a vote commits to: the inscription id when known, else the content hash. */
export function voteReference(order: Pick<Order, 'inscriptionId' | 'contentSha256'>): string {
  return order.inscriptionId ?? order.contentSha256;
}

/** `Approve Degent order <id> (<ref>)` / `Decline Degent order <id> (<ref>)`. */
export function voteStatement(vote: VoteChoice, orderId: string, ref: string): string {
  return `${vote === 'approve' ? 'Approve' : 'Decline'} Degent order ${orderId} (${ref})`;
}

const STATEMENT_RE = /^(Approve|Decline) Degent order ([A-Za-z0-9_-]{1,64}) \(([0-9a-f]{64}(?:i[0-9]+)?)\)$/;

/** Parses a statement back into its parts; null when it is not a vote statement. */
export function parseVoteStatement(message: string): { vote: VoteChoice; orderId: string; ref: string } | null {
  const m = STATEMENT_RE.exec(message);
  if (!m) return null;
  return { vote: m[1] === 'Approve' ? 'approve' : 'decline', orderId: m[2]!, ref: m[3]! };
}

/** Degent number for the k-th approved mint (1-based rank): 4112 + rank. */
export function degentNumberForRank(rank: number, gallerySize = GALLERY_SIZE): number {
  if (!Number.isInteger(rank) || rank < 1) throw new RangeError('rank must be a positive integer');
  return gallerySize + rank;
}
