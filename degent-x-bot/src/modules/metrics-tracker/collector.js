const { eq, and, isNull, gte } = require('drizzle-orm');
const { getTweetMetrics } = require('../../services/twitter-client');
const { getDb } = require('../../services/database');
const { contentQueue, postMetrics } = require('../../db/schema');
const logger = require('../../lib/logger');

async function collectMetrics() {
  const db = getDb();

  // Get all posted content that has a tweet_id
  const posted = await db.select()
    .from(contentQueue)
    .where(
      and(
        eq(contentQueue.status, 'posted'),
        // Only collect for tweets posted in the last 7 days
        gte(contentQueue.postedAt, new Date(Date.now() - 7 * 24 * 3600 * 1000))
      )
    );

  let collected = 0;

  for (const item of posted) {
    if (!item.tweetId) continue;

    try {
      const tweetData = await getTweetMetrics(item.tweetId);
      const metrics = tweetData?.public_metrics;
      if (!metrics) continue;

      const impressions = metrics.impression_count || 0;
      const likes = metrics.like_count || 0;
      const retweets = metrics.retweet_count || 0;
      const replies = metrics.reply_count || 0;
      const quoteTweets = metrics.quote_count || 0;
      const bookmarks = metrics.bookmark_count || 0;

      const engagementRate = impressions > 0
        ? (likes + retweets + replies + quoteTweets) / impressions
        : 0;

      // Determine snapshot timing
      const hoursSincePost = item.postedAt
        ? (Date.now() - new Date(item.postedAt).getTime()) / (1000 * 3600)
        : 0;

      const snapshot = { impressions, likes, retweets, replies, quoteTweets, bookmarks, collectedAt: new Date().toISOString() };

      // Check if metrics record exists
      const existing = await db.select()
        .from(postMetrics)
        .where(eq(postMetrics.tweetId, item.tweetId));

      if (existing.length > 0) {
        const updates = {
          impressions,
          likes,
          retweets,
          replies,
          quoteTweets,
          bookmarks,
          engagementRate,
          lastUpdated: new Date(),
        };

        // Store snapshots at milestones
        if (hoursSincePost >= 1 && !existing[0].metrics1h) updates.metrics1h = snapshot;
        if (hoursSincePost >= 24 && !existing[0].metrics24h) updates.metrics24h = snapshot;
        if (hoursSincePost >= 168 && !existing[0].metrics7d) updates.metrics7d = snapshot;

        await db.update(postMetrics)
          .set(updates)
          .where(eq(postMetrics.tweetId, item.tweetId));
      } else {
        await db.insert(postMetrics).values({
          contentQueueId: item.id,
          tweetId: item.tweetId,
          impressions,
          likes,
          retweets,
          replies,
          quoteTweets,
          bookmarks,
          engagementRate,
        });
      }

      collected++;
    } catch (err) {
      logger.error({ err, tweetId: item.tweetId }, 'Failed to collect metrics for tweet');
    }
  }

  logger.info({ collected, total: posted.length }, 'Metrics collection complete');
  return { collected };
}

module.exports = { collectMetrics };
