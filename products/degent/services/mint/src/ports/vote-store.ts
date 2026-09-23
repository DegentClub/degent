import type { VoteRecord } from '../domain/approval.js';

/** Persistence for member votes: append-only, unique per (orderId, voterAddress). */
export interface VoteStore {
  /** Throws when the (orderId, voterAddress) pair already exists. */
  add(vote: VoteRecord): Promise<void>;
  listByOrder(orderId: string): Promise<VoteRecord[]>;
  /** Orders this address voted on, for the review queue's "voted" marker. */
  listByVoter(voterAddress: string): Promise<VoteRecord[]>;
}
