const { getRedis } = require('../services/redis-client');
const logger = require('./logger');

const DEDUP_KEY_PREFIX = 'dedup:tweet:';
const DEDUP_WINDOW_SECONDS = 7 * 24 * 3600; // 7 days

// Simple token-based similarity check
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

async function isDuplicate(newContent, threshold = 0.85) {
  const redis = getRedis();
  const keys = await redis.keys(`${DEDUP_KEY_PREFIX}*`);

  for (const key of keys) {
    const existingContent = await redis.get(key);
    if (existingContent) {
      const similarity = jaccardSimilarity(newContent, existingContent);
      if (similarity >= threshold) {
        logger.info({ similarity, existingKey: key }, 'Duplicate content detected');
        return true;
      }
    }
  }
  return false;
}

async function recordContent(tweetId, content) {
  const redis = getRedis();
  const key = `${DEDUP_KEY_PREFIX}${tweetId}`;
  await redis.set(key, content, 'EX', DEDUP_WINDOW_SECONDS);
}

module.exports = { isDuplicate, recordContent, jaccardSimilarity };
