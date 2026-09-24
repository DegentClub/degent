/** In-memory MemberStore (tests, regtest dev). Same semantics as the sqlite adapter. */
import { addressKey } from '../domain/address.js';
import type { Member, MemberStats, MemberStore } from '../ports/member-store.js';

export class MemoryMemberStore implements MemberStore {
  readonly members = new Map<number, Member>();
  private readonly links = new Map<string, number>();

  async findByTelegramId(id: number): Promise<Member | null> {
    const m = this.members.get(id);
    return m ? { ...m, degents: [...m.degents] } : null;
  }

  async findActiveByAddress(address: string): Promise<Member | null> {
    const key = addressKey(address);
    for (const m of this.members.values()) if (m.status === 'active' && addressKey(m.address) === key) return { ...m, degents: [...m.degents] };
    return null;
  }

  async upsertVerified(v: { telegramUserId: number; address: string; degents: number[]; at: string }): Promise<Member> {
    const existing = this.members.get(v.telegramUserId);
    const row: Member = {
      telegramUserId: v.telegramUserId,
      address: v.address,
      degents: [...v.degents],
      status: 'active',
      verifiedAt: v.at,
      lastCheckedAt: v.at,
      revokedAt: null,
      inviteIssuedAt: existing?.inviteIssuedAt ?? null,
      invitesIssued: existing?.invitesIssued ?? 0,
      kickPending: false,
    };
    this.members.set(v.telegramUserId, row);
    return { ...row };
  }

  async recordInvite(id: number, at: string): Promise<void> {
    const m = this.members.get(id);
    if (m) {
      m.inviteIssuedAt = at;
      m.invitesIssued++;
    }
  }

  async listActive(): Promise<Member[]> {
    return [...this.members.values()].filter((m) => m.status === 'active').map((m) => ({ ...m, degents: [...m.degents] }));
  }

  async listKickPending(): Promise<Member[]> {
    return [...this.members.values()].filter((m) => m.status === 'revoked' && m.kickPending).map((m) => ({ ...m }));
  }

  async updateHoldings(id: number, degents: number[], at: string): Promise<void> {
    const m = this.members.get(id);
    if (m) {
      m.degents = [...degents];
      m.lastCheckedAt = at;
    }
  }

  async revoke(id: number, at: string): Promise<void> {
    const m = this.members.get(id);
    if (m) Object.assign(m, { status: 'revoked', revokedAt: at, lastCheckedAt: at, degents: [], kickPending: true });
  }

  async markKicked(id: number): Promise<void> {
    const m = this.members.get(id);
    if (m) m.kickPending = false;
  }

  async consumeLink(jti: string, expiresAtMs: number, now: number): Promise<boolean> {
    for (const [k, exp] of this.links) if (exp <= now) this.links.delete(k);
    if (this.links.has(jti)) return false;
    this.links.set(jti, expiresAtMs);
    return true;
  }

  async stats(): Promise<MemberStats> {
    const all = [...this.members.values()];
    const active = all.filter((m) => m.status === 'active');
    return {
      activeMembers: active.length,
      revokedMembers: all.length - active.length,
      degentsHeld: active.reduce((n, m) => n + m.degents.length, 0),
      invitesIssued: all.reduce((n, m) => n + m.invitesIssued, 0),
      kickPending: all.filter((m) => m.status === 'revoked' && m.kickPending).length,
    };
  }
}
