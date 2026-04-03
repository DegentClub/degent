const { getRedis } = require('../services/redis-client');
const logger = require('./logger');

// X API v2 rate limits
const RATE_LIMITS = {
  'POST /tweets': { limit: 100, window: 86400 },         // 100 per 24h (Basic)
  'POST /likes': { limit: 1000, window: 86400 },          // 1000 per 24h
  'POST /retweets': { limit: 100, window: 86400 },        // 100 per 24h (Basic)
  'GET /users/timeline': { limit: 100, window: 900 },     // 100 per 15 min
  'GET /tweets/search': { limit: 100, window: 900 },      // 100 per 15 min
  'POST /follows': { limit: 400, window: 86400 },         // 400 per 24h
};

function redisKey(endpoint) {
  return `ratelimit:${endpoint}`;
}

async function canExecute(endpoint) {
  const redis = getRedis();
  const limits = RATE_LIMITS[endpoint];
  if (!limits) return true;

  const key = redisKey(endpoint);
  const current = await redis.get(key);
  const count = current ? parseInt(current, 10) : 0;
  return count < limits.limit;
}

async function recordUsage(endpoint) {
  const redis = getRedis();
  const limits = RATE_LIMITS[endpoint];
  if (!limits) return;

  const key = redisKey(endpoint);
  const exists = await redis.exists(key);
  await redis.incr(key);
  if (!exists) {
    await redis.expire(key, limits.window);
  }
  logger.debug({ endpoint, key }, 'Rate limit usage recorded');
}

async function getRemaining(endpoint) {
  const redis = getRedis();
  const limits = RATE_LIMITS[endpoint];
  if (!limits) return Infinity;

  const key = redisKey(endpoint);
  const current = await redis.get(key);
  const count = current ? parseInt(current, 10) : 0;
  return Math.max(0, limits.limit - count);
}

async function getBackoffTime(endpoint) {
  const redis = getRedis();
  const key = redisKey(endpoint);
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : 0;
}

module.exports = {
  canExecute,
  recordUsage,
  getRemaining,
  getBackoffTime,
  RATE_LIMITS,
};
