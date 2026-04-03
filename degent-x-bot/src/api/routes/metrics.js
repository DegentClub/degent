const { eq, desc, gte } = require('drizzle-orm');
const { getDb } = require('../../services/database');
const { dailyMetrics, postMetrics } = require('../../db/schema');

async function metricsRoutes(fastify) {
  // Daily metrics
  fastify.get('/daily', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const days = parseInt(request.query.days || '7', 10);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().split('T')[0];
    const items = await db.select().from(dailyMetrics).where(gte(dailyMetrics.date, since)).orderBy(desc(dailyMetrics.date));
    return { items, count: items.length };
  });

  // Per-post performance
  fastify.get('/posts', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const items = await db.select().from(postMetrics).orderBy(desc(postMetrics.createdAt)).limit(50);
    return { items, count: items.length };
  });

  // Top performing posts
  fastify.get('/top-posts', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const items = await db.select().from(postMetrics).orderBy(desc(postMetrics.engagementRate)).limit(20);
    return { items, count: items.length };
  });
}

module.exports = metricsRoutes;
