// In-memory repository with the same interface as repo-postgres.js.
// Used by tests and by `GATE_REPO=memory` for local dry runs.

function createMemoryRepo({ now = Date.now } = {}) {
  const challenges = new Map(); // nonce -> row
  const members = new Map(); // telegramUserId -> row
  let seq = 0;

  return {
    async createChallenge({ telegramUserId, address, nonce, expiresAt }) {
      if (challenges.has(nonce)) throw new Error('duplicate nonce');
      const row = { id: `c${++seq}`, telegramUserId, address, nonce, expiresAt, usedAt: null, createdAt: new Date(now()) };
      challenges.set(nonce, row);
      return row;
    },

    /** Atomically mark a nonce used. Returns the row, or null if unknown/used/expired. */
    async consumeChallenge(nonce) {
      const row = challenges.get(nonce);
      if (!row || row.usedAt || row.expiresAt.getTime() <= now()) return null;
      row.usedAt = new Date(now());
      return row;
    },

    async findMemberByTelegramId(telegramUserId) {
      return members.get(telegramUserId) || null;
    },

    async findMemberByAddress(address) {
      const key = address.toLowerCase();
      for (const m of members.values()) if (m.address.toLowerCase() === key) return m;
      return null;
    },

    async upsertMember({ telegramUserId, address, degents }) {
      const existing = members.get(telegramUserId);
      const t = new Date(now());
      if (existing) {
        Object.assign(existing, { address, degents, status: 'active', verifiedAt: t, lastCheckedAt: t, revokedAt: null });
        return existing;
      }
      const row = {
        id: `m${++seq}`,
        telegramUserId,
        address,
        degents,
        status: 'active',
        verifiedAt: t,
        lastCheckedAt: t,
        revokedAt: null,
        inviteIssuedAt: null,
      };
      members.set(telegramUserId, row);
      return row;
    },

    async markInviteIssued(telegramUserId) {
      const m = members.get(telegramUserId);
      if (m) m.inviteIssuedAt = new Date(now());
      return m;
    },

    async listActiveMembers() {
      return [...members.values()].filter((m) => m.status === 'active');
    },

    async updateHoldings(telegramUserId, degents) {
      const m = members.get(telegramUserId);
      if (m) {
        m.degents = degents;
        m.lastCheckedAt = new Date(now());
      }
      return m;
    },

    async revokeMember(telegramUserId) {
      const m = members.get(telegramUserId);
      if (m) {
        m.status = 'revoked';
        m.revokedAt = new Date(now());
        m.lastCheckedAt = new Date(now());
        m.degents = [];
      }
      return m;
    },

    async stats() {
      const all = [...members.values()];
      const active = all.filter((m) => m.status === 'active');
      return {
        activeMembers: active.length,
        revokedMembers: all.length - active.length,
        degentsHeld: active.reduce((n, m) => n + m.degents.length, 0),
        openChallenges: [...challenges.values()].filter((c) => !c.usedAt && c.expiresAt.getTime() > now()).length,
      };
    },

    // test helpers
    _members: members,
    _challenges: challenges,
  };
}

module.exports = { createMemoryRepo };
