import type { DatabaseSync } from 'node:sqlite';
import type { VoteRecord } from '../domain/approval.js';
import type { VoteStore } from '../ports/vote-store.js';
import type { NonceConsumeResult, NonceRecord, NonceStore } from '@bsh/identity';

const dupError = (v: VoteRecord) => new Error(`vote by ${v.voterAddress} on ${v.orderId} already exists`);

/** In-memory VoteStore (dev, tests). */
export class MemoryVoteStore implements VoteStore {
  private readonly votes: VoteRecord[] = [];

  async add(vote: VoteRecord): Promise<void> {
    if (this.votes.some((v) => v.orderId === vote.orderId && (v.voterAddress === vote.voterAddress || v.voterDegent === vote.voterDegent))) throw dupError(vote);
    this.votes.push(structuredClone(vote));
  }

  async listByOrder(orderId: string): Promise<VoteRecord[]> {
    return this.votes.filter((v) => v.orderId === orderId).map((v) => structuredClone(v));
  }

  async listByVoter(voterAddress: string): Promise<VoteRecord[]> {
    return this.votes.filter((v) => v.voterAddress === voterAddress).map((v) => structuredClone(v));
  }
}

const VOTE_SCHEMA = `
CREATE TABLE IF NOT EXISTS votes (
  order_id      TEXT NOT NULL,
  voter_address TEXT NOT NULL,
  voter_degent  INTEGER NOT NULL,
  vote          TEXT NOT NULL,
  at            TEXT NOT NULL,
  signature     TEXT NOT NULL,
  message       TEXT NOT NULL,
  PRIMARY KEY (order_id, voter_address)
);
CREATE INDEX IF NOT EXISTS votes_voter ON votes(voter_address);
-- Each vote is backed by a distinct Degent (a Degent moved to another address cannot vote twice).
CREATE UNIQUE INDEX IF NOT EXISTS votes_order_degent ON votes(order_id, voter_degent);
`;

type Row = { order_id: string; voter_address: string; voter_degent: number; vote: string; at: string; signature: string; message: string };
const fromRow = (r: Row): VoteRecord => ({
  orderId: r.order_id,
  voterAddress: r.voter_address,
  voterDegent: Number(r.voter_degent),
  vote: r.vote as VoteRecord['vote'],
  at: r.at,
  signature: r.signature,
  message: r.message,
});

/** node:sqlite VoteStore sharing the order store's database (same file, same WAL). */
export class SqliteVoteStore implements VoteStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(VOTE_SCHEMA);
  }

  async add(v: VoteRecord): Promise<void> {
    try {
      this.db
        .prepare('INSERT INTO votes (order_id, voter_address, voter_degent, vote, at, signature, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(v.orderId, v.voterAddress, v.voterDegent, v.vote, v.at, v.signature, v.message);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw dupError(v);
      throw e;
    }
  }

  async listByOrder(orderId: string): Promise<VoteRecord[]> {
    return (this.db.prepare('SELECT * FROM votes WHERE order_id = ? ORDER BY at, voter_address').all(orderId) as Row[]).map(fromRow);
  }

  async listByVoter(voterAddress: string): Promise<VoteRecord[]> {
    return (this.db.prepare('SELECT * FROM votes WHERE voter_address = ? ORDER BY at').all(voterAddress) as Row[]).map(fromRow);
  }
}

const NONCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS siwb_nonces (
  nonce      TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  address    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
`;

/**
 * node:sqlite NonceStore for @bsh/identity: `consume` is one atomic UPDATE guarded by
 * `used_at IS NULL`, so two concurrent verifications of the same challenge cannot both succeed.
 */
export class SqliteNonceStore implements NonceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly retainMs = 60_000,
  ) {
    db.exec(NONCE_SCHEMA);
  }

  async issue(record: NonceRecord): Promise<void> {
    this.db.prepare('DELETE FROM siwb_nonces WHERE expires_at + ? < ?').run(this.retainMs, Date.now());
    try {
      this.db.prepare('INSERT INTO siwb_nonces (nonce, domain, address, expires_at) VALUES (?, ?, ?, ?)').run(record.nonce, record.domain, record.address, record.expiresAt);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw new Error('nonce already issued');
      throw e;
    }
  }

  async consume(nonce: string, binding: { domain: string; address: string }, now: number): Promise<NonceConsumeResult> {
    const row = this.db.prepare('SELECT domain, address, expires_at, used_at FROM siwb_nonces WHERE nonce = ?').get(nonce) as
      | { domain: string; address: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row) return 'unknown';
    if (row.used_at !== null) return 'replayed';
    if (row.domain !== binding.domain || row.address !== binding.address) return 'unknown';
    if (now >= Number(row.expires_at)) return 'expired';
    const res = this.db.prepare('UPDATE siwb_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL').run(now, nonce);
    return Number(res.changes) === 1 ? 'ok' : 'replayed';
  }
}
