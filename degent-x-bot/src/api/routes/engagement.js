const { eq } = require('drizzle-orm');
const { getDb } = require('../../services/database');
const { engagementLog, trackedAccounts } = require('../../db/schema');

async function engagementRoutes(fastify) {
  // Get engagement log
  fastify.get('/log', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const items = await db.select().from(engagementLog).orderBy(engagementLog.createdAt).limit(100);
    return { items, count: items.length };
  });

  // Get tracked accounts
  fastify.get('/accounts', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const items = await db.select().from(trackedAccounts).orderBy(trackedAccounts.tier);
    return { items, count: items.length };
  });

  // Add tracked account
  fastify.post('/accounts', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const { twitterUserId, username, displayName, tier, category, engagementFrequency, notes } = request.body;
    const [record] = await db.insert(trackedAccounts).values({
      twitterUserId,
      username,
      displayName,
      tier: tier || 2,
      category,
      engagementFrequency: engagementFrequency || 'daily',
      notes,
    }).returning();
    return record;
  });

  // Update tracked account
  fastify.patch('/accounts/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const db = getDb();
    const updates = { ...request.body, updatedAt: new Date() };
    delete updates.id;
    const updated = await db.update(trackedAccounts)
      .set(updates)
      .where(eq(trackedAccounts.id, request.params.id))
      .returning();
    if (updated.length === 0) return reply.code(404).send({ error: 'Not found' });
    return updated[0];
  });

  // Delete tracked account
  fastify.delete('/accounts/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const db = getDb();
    const deleted = await db.delete(trackedAccounts).where(eq(trackedAccounts.id, request.params.id)).returning();
    if (deleted.length === 0) return reply.code(404).send({ error: 'Not found' });
    return { deleted: true };
  });
}

module.exports = engagementRoutes;
