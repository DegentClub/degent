// Postgres repository for the gate, on the shared drizzle connection.
// Interface mirrors repo-memory.js.

const { eq, and, gt, isNull, sql } = require('drizzle-orm');
const { getDb } = require('../services/database');
const { gateChallenges, gateMembers } = require('../db/schema');

function createPostgresRepo() {
  const db = getDb();

  return {
    async createChallenge({ telegramUserId, address, nonce, expiresAt }) {
      const [row] = await db.insert(gateChallenges).values({ telegramUserId, address, nonce, expiresAt }).returning();
      return row;
    },

    async consumeChallenge(nonce) {
      // Single statement: only an unused, unexpired nonce is updated, so two
      // concurrent verifies cannot both succeed.
      const [row] = await db.update(gateChallenges)
        .set({ usedAt: new Date() })
        .where(and(eq(gateChallenges.nonce, nonce), isNull(gateChallenges.usedAt), gt(gateChallenges.expiresAt, new Date())))
        .returning();
      return row || null;
    },

    async findMemberByTelegramId(telegramUserId) {
      const [row] = await db.select().from(gateMembers).where(eq(gateMembers.telegramUserId, telegramUserId)).limit(1);
      return row || null;
    },

    async findMemberByAddress(address) {
      const [row] = await db.select().from(gateMembers)
        .where(sql`lower(${gateMembers.address}) = lower(${address})`)
        .limit(1);
      return row || null;
    },

    async upsertMember({ telegramUserId, address, degents }) {
      const t = new Date();
      const [row] = await db.insert(gateMembers)
        .values({ telegramUserId, address, degents, status: 'active', verifiedAt: t, lastCheckedAt: t })
        .onConflictDoUpdate({
          target: gateMembers.telegramUserId,
          set: { address, degents, status: 'active', verifiedAt: t, lastCheckedAt: t, revokedAt: null },
        })
        .returning();
      return row;
    },

    async markInviteIssued(telegramUserId) {
      const [row] = await db.update(gateMembers)
        .set({ inviteIssuedAt: new Date() })
        .where(eq(gateMembers.telegramUserId, telegramUserId))
        .returning();
      return row || null;
    },

    async listActiveMembers() {
      return db.select().from(gateMembers).where(eq(gateMembers.status, 'active'));
    },

    async updateHoldings(telegramUserId, degents) {
      const [row] = await db.update(gateMembers)
        .set({ degents, lastCheckedAt: new Date() })
        .where(eq(gateMembers.telegramUserId, telegramUserId))
        .returning();
      return row || null;
    },

    async revokeMember(telegramUserId) {
      const t = new Date();
      const [row] = await db.update(gateMembers)
        .set({ status: 'revoked', revokedAt: t, lastCheckedAt: t, degents: [] })
        .where(eq(gateMembers.telegramUserId, telegramUserId))
        .returning();
      return row || null;
    },

    async stats() {
      const [counts] = await db.select({
        activeMembers: sql`count(*) filter (where ${gateMembers.status} = 'active')`.mapWith(Number),
        revokedMembers: sql`count(*) filter (where ${gateMembers.status} <> 'active')`.mapWith(Number),
        degentsHeld: sql`coalesce(sum(jsonb_array_length(${gateMembers.degents})) filter (where ${gateMembers.status} = 'active'), 0)`.mapWith(Number),
      }).from(gateMembers);
      const [open] = await db.select({ n: sql`count(*)`.mapWith(Number) })
        .from(gateChallenges)
        .where(and(isNull(gateChallenges.usedAt), gt(gateChallenges.expiresAt, new Date())));
      return { ...counts, openChallenges: open.n };
    },
  };
}

module.exports = { createPostgresRepo };
