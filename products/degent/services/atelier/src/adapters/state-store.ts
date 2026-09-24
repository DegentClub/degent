/**
 * Durable-ish state: anonymous sessions (token hashes only) and the cost ledger that enforces the
 * per-session daily generation quota and the global daily cost cap. Two adapters, one interface:
 * memory (tests, demo) and node:sqlite (deployments). Jobs and candidates are ephemeral and live in
 * the JobStore instead.
 */
import { DatabaseSync } from 'node:sqlite';

export interface SessionRecord {
  id: string;
  /** SHA-256 hex of the bearer token; the token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  ip: string;
}

export type LedgerStatus = 'reserved' | 'settled' | 'failed';

export interface LedgerEntry {
  id: string;
  sessionId: string;
  kind: 'generate';
  images: number;
  costCents: number;
  status: LedgerStatus;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

export interface StateStore {
  createSession(s: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  findSessionByTokenHash(hash: string): Promise<SessionRecord | null>;
  countSessionsByIpSince(ip: string, sinceIso: string): Promise<number>;

  record(e: LedgerEntry): Promise<void>;
  settle(id: string, patch: { status: LedgerStatus; costCents?: number; updatedAt: string }): Promise<void>;
  /** Images charged to a session since `sinceIso` (reserved + settled). */
  sessionImagesSince(sessionId: string, sinceIso: string): Promise<number>;
  /** Cents charged globally since `sinceIso` (reserved + settled). */
  costCentsSince(sinceIso: string): Promise<number>;
  entriesForSession(sessionId: string): Promise<LedgerEntry[]>;
  close(): void;
}

export class MemoryStateStore implements StateStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly ledger = new Map<string, LedgerEntry>();
  async createSession(s: SessionRecord): Promise<void> {
    this.sessions.set(s.id, { ...s });
  }
  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }
  async findSessionByTokenHash(hash: string): Promise<SessionRecord | null> {
    for (const s of this.sessions.values()) if (s.tokenHash === hash) return s;
    return null;
  }
  async countSessionsByIpSince(ip: string, sinceIso: string): Promise<number> {
    let n = 0;
    for (const s of this.sessions.values()) if (s.ip === ip && s.createdAt >= sinceIso) n++;
    return n;
  }
  async record(e: LedgerEntry): Promise<void> {
    this.ledger.set(e.id, { ...e });
  }
  async settle(id: string, patch: { status: LedgerStatus; costCents?: number; updatedAt: string }): Promise<void> {
    const e = this.ledger.get(id);
    if (!e) return;
    e.status = patch.status;
    if (patch.costCents !== undefined) e.costCents = patch.costCents;
    e.updatedAt = patch.updatedAt;
  }
  async sessionImagesSince(sessionId: string, sinceIso: string): Promise<number> {
    let n = 0;
    for (const e of this.ledger.values()) if (e.sessionId === sessionId && e.status !== 'failed' && e.createdAt >= sinceIso) n += e.images;
    return n;
  }
  async costCentsSince(sinceIso: string): Promise<number> {
    let n = 0;
    for (const e of this.ledger.values()) if (e.status !== 'failed' && e.createdAt >= sinceIso) n += e.costCents;
    return n;
  }
  async entriesForSession(sessionId: string): Promise<LedgerEntry[]> {
    return [...this.ledger.values()].filter((e) => e.sessionId === sessionId).map((e) => ({ ...e }));
  }
  close(): void {}
}

export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_ip_created ON sessions (ip, created_at);
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, images INTEGER NOT NULL, cost_cents INTEGER NOT NULL,
        status TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_session_created ON ledger (session_id, created_at);
      CREATE INDEX IF NOT EXISTS ledger_created ON ledger (created_at);
    `);
  }
  async createSession(s: SessionRecord): Promise<void> {
    this.db.prepare('INSERT INTO sessions (id, token_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)').run(s.id, s.tokenHash, s.createdAt, s.expiresAt, s.ip);
  }
  private rowToSession(r: Record<string, unknown> | undefined): SessionRecord | null {
    return r ? { id: r.id as string, tokenHash: r.token_hash as string, createdAt: r.created_at as string, expiresAt: r.expires_at as string, ip: r.ip as string } : null;
  }
  async getSession(id: string): Promise<SessionRecord | null> {
    return this.rowToSession(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  }
  async findSessionByTokenHash(hash: string): Promise<SessionRecord | null> {
    return this.rowToSession(this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash) as Record<string, unknown> | undefined);
  }
  async countSessionsByIpSince(ip: string, sinceIso: string): Promise<number> {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ip = ? AND created_at >= ?').get(ip, sinceIso) as { n: number };
    return Number(r.n);
  }
  async record(e: LedgerEntry): Promise<void> {
    this.db
      .prepare('INSERT INTO ledger (id, session_id, kind, images, cost_cents, status, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.sessionId, e.kind, e.images, e.costCents, e.status, e.provider, e.createdAt, e.updatedAt);
  }
  async settle(id: string, patch: { status: LedgerStatus; costCents?: number; updatedAt: string }): Promise<void> {
    if (patch.costCents === undefined) this.db.prepare('UPDATE ledger SET status = ?, updated_at = ? WHERE id = ?').run(patch.status, patch.updatedAt, id);
    else this.db.prepare('UPDATE ledger SET status = ?, cost_cents = ?, updated_at = ? WHERE id = ?').run(patch.status, patch.costCents, patch.updatedAt, id);
  }
  async sessionImagesSince(sessionId: string, sinceIso: string): Promise<number> {
    const r = this.db.prepare("SELECT COALESCE(SUM(images), 0) AS n FROM ledger WHERE session_id = ? AND status != 'failed' AND created_at >= ?").get(sessionId, sinceIso) as { n: number };
    return Number(r.n);
  }
  async costCentsSince(sinceIso: string): Promise<number> {
    const r = this.db.prepare("SELECT COALESCE(SUM(cost_cents), 0) AS n FROM ledger WHERE status != 'failed' AND created_at >= ?").get(sinceIso) as { n: number };
    return Number(r.n);
  }
  async entriesForSession(sessionId: string): Promise<LedgerEntry[]> {
    const rows = this.db.prepare('SELECT * FROM ledger WHERE session_id = ? ORDER BY created_at').all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      kind: 'generate',
      images: Number(r.images),
      costCents: Number(r.cost_cents),
      status: r.status as LedgerStatus,
      provider: r.provider as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }
  close(): void {
    this.db.close();
  }
}
