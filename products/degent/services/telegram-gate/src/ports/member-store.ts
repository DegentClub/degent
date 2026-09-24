/**
 * Verified members: one row per Telegram account, holding the one wallet it proved. The one-wallet-one-account
 * rule is enforced by the service (`findActiveByAddress`) and, in the sqlite adapter, by a partial unique index.
 * Privacy: Telegram user id, address, Degent numbers and timestamps only — no usernames, messages, IPs or signatures.
 */
export type MemberStatus = 'active' | 'revoked';

export interface Member {
  telegramUserId: number;
  address: string;
  degents: number[];
  status: MemberStatus;
  verifiedAt: string;
  lastCheckedAt: string;
  revokedAt: string | null;
  inviteIssuedAt: string | null;
  invitesIssued: number;
  /** Revoked but the ban/unban call has not succeeded yet; the next re-verification retries it. */
  kickPending: boolean;
}

export interface MemberStats {
  activeMembers: number;
  revokedMembers: number;
  degentsHeld: number;
  invitesIssued: number;
  kickPending: number;
}

export interface MemberStore {
  findByTelegramId(telegramUserId: number): Promise<Member | null>;
  /** The ACTIVE member linked to this address (bech32 compared case-insensitively), if any. */
  findActiveByAddress(address: string): Promise<Member | null>;
  /** Insert or re-activate the member for this Telegram account with this address. */
  upsertVerified(m: { telegramUserId: number; address: string; degents: number[]; at: string }): Promise<Member>;
  recordInvite(telegramUserId: number, at: string): Promise<void>;
  listActive(): Promise<Member[]>;
  listKickPending(): Promise<Member[]>;
  updateHoldings(telegramUserId: number, degents: number[], at: string): Promise<void>;
  /** status=revoked, degents=[], kickPending=true. */
  revoke(telegramUserId: number, at: string): Promise<void>;
  markKicked(telegramUserId: number): Promise<void>;
  /** Single-use /verify links: true the first time a jti is consumed, false afterwards. */
  consumeLink(jti: string, expiresAtMs: number, now: number): Promise<boolean>;
  stats(): Promise<MemberStats>;
}
