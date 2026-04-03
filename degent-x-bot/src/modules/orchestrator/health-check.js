const { getRedis } = require('../../services/redis-client');
const { getDb } = require('../../services/database');
const logger = require('../../lib/logger');

async function checkHealth() {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {},
  };

  // Check Redis
  try {
    const redis = getRedis();
    await redis.ping();
    health.services.redis = { status: 'ok' };
  } catch (err) {
    health.services.redis = { status: 'error', error: err.message };
    health.status = 'degraded';
  }

  // Check Postgres
  try {
    const db = getDb();
    // Simple query to check DB
    const { sql } = require('drizzle-orm');
    await db.execute(sql`SELECT 1`);
    health.services.postgres = { status: 'ok' };
  } catch (err) {
    health.services.postgres = { status: 'error', error: err.message };
    health.status = 'degraded';
  }

  if (health.status !== 'ok') {
    logger.warn({ health }, 'Health check: degraded');
  }

  return health;
}

module.exports = { checkHealth };
