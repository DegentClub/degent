/**
 * node:sqlite adapters (Node >= 22.5), one database file: members, used link ids, SIWB nonces.
 * WAL mode; a partial unique index backs the one-wallet-one-account rule among active members.
 */
import { DatabaseSync } from 'node:sqlite';
import type { NonceConsumeResult, NonceRecord, NonceStore } from '@bsh/identity';
import { addressKey } from '../domain/address.js';
import type { Member, MemberStats, MemberStore } from '../ports/member-store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gate_members (
  telegram_user_id INTEGER PRIMARY KEY,
  address          TEXT NOT NULL,
  address_key      TEXT NOT NULL,
  degents          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  verified_at      TEXT NOT NULL,
  last_checked_at  TEXT NOT NULL,
  revoked_at       TEXT,
  invite_issued_at TEXT,
  invites_issued   INTEGER NOT NULL DEFAULT 0,
  kick_pending     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS gate_members_active_address ON gate_members(address_key) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS gate_used_links (
  jti        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gate_siwb_nonces (
  nonce      TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  address    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
`;

interface Row {
  telegram_user_id: number | bigint;
  address: string;
  degents: string;
  status: 'active' | 'revoked';
  verified_at: string;
  last_checked_at: string;
  revoked_at: string | null;
  invite_issued_at: string | null;
  invites_issued: number | bigint;
  kick_pending: number | bigint;
}

const toMember = (r: Row): Member => ({
  telegramUserId: Number(r.telegram_user_id),
  address: r.address,
  degents: JSON.parse(r.degents) as number[],
  status: r.status,
  verifiedAt: r.verified_at,
  lastCheckedAt: r.last_checked_at,
  revokedAt: r.revoked_at,
  inviteIssuedAt: r.invite_issued_at,
  invitesIssued: Number(r.invites_issued),
  kickPending: Number(r.kick_pending) === 1,
});

export function openGateDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export class SqliteMemberStore implements MemberStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  async findByTelegramId(id: number): Promise<Member | null> {
    const r = this.db.prepare('SELECT * FROM gate_members WHERE telegram_user_id = ?').get(id) as Row | undefined;
    return r ? toMember(r) : null;
  }

  async findActiveByAddress(address: string): Promise<Member | null> {
    const r = this.db.prepare("SELECT * FROM gate_members WHERE address_key = ? AND status = 'active'").get(addressKey(address)) as Row | undefined;
    return r ? toMember(r) : null;
  }

  async upsertVerified(v: { telegramUserId: number; address: string; degents: number[]; at: string }): Promise<Member> {
    this.db
      .prepare(
        `INSERT INTO gate_members (telegram_user_id, address, address_key, degents, status, verified_at, last_checked_at, revoked_at, kick_pending)
         VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, 0)
         ON CONFLICT (telegram_user_id) DO UPDATE SET address = excluded.address, address_key = excluded.address_key,
           degents = excluded.degents, status = 'active', verified_at = excluded.verified_at,
           last_checked_at = excluded.last_checked_at, revoked_at = NULL, kick_pending = 0`,
      )
      .run(v.telegramUserId, v.address, addressKey(v.address), JSON.stringify(v.degents), v.at, v.at);
    return (await this.findByTelegramId(v.telegramUserId))!;
  }

  async recordInvite(id: number, at: string): Promise<void> {
    this.db.prepare('UPDATE gate_members SET invite_issued_at = ?, invites_issued = invites_issued + 1 WHERE telegram_user_id = ?').run(at, id);
  }

  async listActive(): Promise<Member[]> {
    return (this.db.prepare("SELECT * FROM gate_members WHERE status = 'active' ORDER BY telegram_user_id").all() as unknown as Row[]).map(toMember);
  }

  async listKickPending(): Promise<Member[]> {
    return (this.db.prepare("SELECT * FROM gate_members WHERE status = 'revoked' AND kick_pending = 1 ORDER BY telegram_user_id").all() as unknown as Row[]).map(toMember);
  }

  async updateHoldings(id: number, degents: number[], at: string): Promise<void> {
    this.db.prepare('UPDATE gate_members SET degents = ?, last_checked_at = ? WHERE telegram_user_id = ?').run(JSON.stringify(degents), at, id);
  }

  async revoke(id: number, at: string): Promise<void> {
    this.db
      .prepare("UPDATE gate_members SET status = 'revoked', revoked_at = ?, last_checked_at = ?, degents = '[]', kick_pending = 1 WHERE telegram_user_id = ?")
      .run(at, at, id);
  }

  async markKicked(id: number): Promise<void> {
    this.db.prepare('UPDATE gate_members SET kick_pending = 0 WHERE telegram_user_id = ?').run(id);
  }

  async consumeLink(jti: string, expiresAtMs: number, now: number): Promise<boolean> {
    this.db.prepare('DELETE FROM gate_used_links WHERE expires_at <= ?').run(now);
    const res = this.db.prepare('INSERT OR IGNORE INTO gate_used_links (jti, expires_at) VALUES (?, ?)').run(jti, expiresAtMs);
    return Number(res.changes) === 1;
  }

  async stats(): Promise<MemberStats> {
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(status = 'active'), 0) AS active,
           COALESCE(SUM(status = 'revoked'), 0) AS revoked,
           COALESCE(SUM(CASE WHEN status = 'active' THEN json_array_length(degents) ELSE 0 END), 0) AS held,
           COALESCE(SUM(invites_issued), 0) AS invites,
           COALESCE(SUM(status = 'revoked' AND kick_pending = 1), 0) AS pending
         FROM gate_members`,
      )
      .get() as Record<string, number | bigint>;
    return {
      activeMembers: Number(r.active),
      revokedMembers: Number(r.revoked),
      degentsHeld: Number(r.held),
      invitesIssued: Number(r.invites),
      kickPending: Number(r.pending),
    };
  }
}

/** SIWB nonce store (the @bsh/identity port). consume is a single conditional UPDATE, so a replay cannot win twice. */
export class SqliteNonceStore implements NonceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly retainMs = 60_000,
  ) {
    db.exec(SCHEMA);
  }

  async issue(record: NonceRecord): Promise<void> {
    this.db.prepare('DELETE FROM gate_siwb_nonces WHERE expires_at + ? < ?').run(this.retainMs, Date.now());
    try {
      this.db.prepare('INSERT INTO gate_siwb_nonces (nonce, domain, address, expires_at) VALUES (?, ?, ?, ?)').run(record.nonce, record.domain, record.address, record.expiresAt);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) throw new Error('nonce already issued');
      throw e;
    }
  }

  async consume(nonce: string, binding: { domain: string; address: string }, now: number): Promise<NonceConsumeResult> {
    const row = this.db.prepare('SELECT domain, address, expires_at, used_at FROM gate_siwb_nonces WHERE nonce = ?').get(nonce) as
      | { domain: string; address: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row) return 'unknown';
    if (row.used_at !== null) return 'replayed';
    if (row.domain !== binding.domain || row.address !== binding.address) return 'unknown';
    if (now >= Number(row.expires_at)) return 'expired';
    const res = this.db.prepare('UPDATE gate_siwb_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL').run(now, nonce);
    return Number(res.changes) === 1 ? 'ok' : 'replayed';
  }
}
