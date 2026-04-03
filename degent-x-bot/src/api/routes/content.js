const { eq } = require('drizzle-orm');
const { getDb } = require('../../services/database');
const { contentQueue } = require('../../db/schema');
const { generateTweet } = require('../../modules/content-engine');
const { triggerPost } = require('../../modules/orchestrator/scheduler');

async function contentRoutes(fastify) {
  // Get content queue
  fastify.get('/queue', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const status = request.query.status || null;
    let query = db.select().from(contentQueue).orderBy(contentQueue.createdAt);
    // Drizzle doesn't chain .where conditionally easily, so we do it manually
    const items = status
      ? await db.select().from(contentQueue).where(eq(contentQueue.status, status)).orderBy(contentQueue.createdAt)
      : await db.select().from(contentQueue).orderBy(contentQueue.createdAt);
    return { items, count: items.length };
  });

  // Get specific content item
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const db = getDb();
    const items = await db.select().from(contentQueue).where(eq(contentQueue.id, request.params.id));
    if (items.length === 0) return reply.code(404).send({ error: 'Not found' });
    return items[0];
  });

  // Manually add content to queue
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (request) => {
    const db = getDb();
    const { textContent, contentType, mediaUrls, scheduledFor } = request.body;
    const [record] = await db.insert(contentQueue).values({
      contentType: contentType || 'meme',
      source: 'manual',
      status: 'approved',
      textContent,
      mediaUrls: mediaUrls || [],
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      approvalTier: 'manual',
      approvedBy: request.user?.username || 'admin',
    }).returning();
    return record;
  });

  // Approve content
  fastify.patch('/:id/approve', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const db = getDb();
    const updated = await db.update(contentQueue)
      .set({ status: 'approved', approvedBy: request.user?.username || 'admin', updatedAt: new Date() })
      .where(eq(contentQueue.id, request.params.id))
      .returning();
    if (updated.length === 0) return reply.code(404).send({ error: 'Not found' });
    return updated[0];
  });

  // Reject content
  fastify.patch('/:id/reject', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const db = getDb();
    const updated = await db.update(contentQueue)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(contentQueue.id, request.params.id))
      .returning();
    if (updated.length === 0) return reply.code(404).send({ error: 'Not found' });
    return updated[0];
  });

  // Trigger AI content generation on-demand
  fastify.post('/generate', { preHandler: [fastify.authenticate] }, async (request) => {
    const { contentType, context } = request.body || {};
    const result = await generateTweet(contentType || 'meme', context || {});
    if (!result) return { error: 'Generation failed' };

    // Save to queue
    const db = getDb();
    const [record] = await db.insert(contentQueue).values({
      contentType: contentType || 'meme',
      source: 'manual',
      status: 'pending',
      textContent: result.text,
      aiModel: result.model,
      aiPromptUsed: result.prompt,
      contentScore: result.score,
      approvalTier: 'review',
    }).returning();

    return { generated: result, record };
  });

  // Delete content
  fastify.delete('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const db = getDb();
    const deleted = await db.delete(contentQueue).where(eq(contentQueue.id, request.params.id)).returning();
    if (deleted.length === 0) return reply.code(404).send({ error: 'Not found' });
    return { deleted: true };
  });
}

module.exports = contentRoutes;
