const { eq } = require('drizzle-orm');
const { checkHealth } = require('../../modules/orchestrator/health-check');
const { getDb } = require('../../services/database');
const { botConfig } = require('../../db/schema');
const { getRedis } = require('../../services/redis-client');

async function systemRoutes(fastify) {
  // Health check (no auth)
  fastify.get('/health', async () => {
    return checkHealth();
  });

  // Get bot configuration
  fastify.get('/config', { preHandler: [fastify.authenticate] }, async () => {
    const db = getDb();
    const items = await db.select().from(botConfig);
    const configMap = {};
    for (const item of items) {
      configMap[item.key] = item.value;
    }
    return configMap;
  });

  // Update configuration
  fastify.patch('/config', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const updates = request.body;
    const results = [];
    for (const [key, value] of Object.entries(updates)) {
      const existing = await db.select().from(botConfig).where(eq(botConfig.key, key));
      if (existing.length > 0) {
        await db.update(botConfig).set({ value, updatedAt: new Date() }).where(eq(botConfig.key, key));
      } else {
        await db.insert(botConfig).values({ key, value });
      }
      results.push({ key, value });
    }
    return { updated: results };
  });

  // Pause all automated posting
  fastify.post('/system/pause', { preHandler: [fastify.authenticate] }, async () => {
    const redis = getRedis();
    await redis.set('system:paused', 'true');
    return { status: 'paused' };
  });

  // Resume automated posting
  fastify.post('/system/resume', { preHandler: [fastify.authenticate] }, async () => {
    const redis = getRedis();
    await redis.del('system:paused');
    return { status: 'resumed' };
  });
}

module.exports = systemRoutes;
