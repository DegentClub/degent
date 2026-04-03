const { eq, and, gte, lte, sql } = require('drizzle-orm');
const { getDb } = require('../../services/database');
const { postMetrics, dailyMetrics, contentQueue, engagementLog } = require('../../db/schema');
const logger = require('../../lib/logger');

async function aggregateDaily(dateStr) {
  const db = getDb();
  const targetDate = dateStr || new Date().toISOString().split('T')[0];
  const dayStart = new Date(`${targetDate}T00:00:00Z`);
  const dayEnd = new Date(`${targetDate}T23:59:59Z`);

  try {
    // Count posts for the day
    const posts = await db.select()
      .from(contentQueue)
      .where(
        and(
          eq(contentQueue.status, 'posted'),
          gte(contentQueue.postedAt, dayStart),
          lte(contentQueue.postedAt, dayEnd)
        )
      );

    const postsCount = posts.length;
    const threadsCount = posts.filter((p) => p.threadTweets).length;
    const telegramReposts = posts.filter((p) => p.source === 'telegram').length;

    // Count engagement actions for the day
    const engagements = await db.select()
      .from(engagementLog)
      .where(
        and(
          gte(engagementLog.createdAt, dayStart),
          lte(engagementLog.createdAt, dayEnd)
        )
      );

    const likesGiven = engagements.filter((e) => e.actionType === 'like').length;
    const retweetsGiven = engagements.filter((e) => e.actionType === 'retweet').length;
    const repliesGiven = engagements.filter((e) => e.actionType === 'reply').length;
    const followsGiven = engagements.filter((e) => e.actionType === 'follow').length;

    // Aggregate received metrics from posts
    const tweetIds = posts.map((p) => p.tweetId).filter(Boolean);
    let totalImpressions = 0;
    let totalLikes = 0;
    let totalRetweets = 0;
    let totalReplies = 0;

    if (tweetIds.length > 0) {
      for (const tweetId of tweetIds) {
        const metrics = await db.select()
          .from(postMetrics)
          .where(eq(postMetrics.tweetId, tweetId));

        if (metrics.length > 0) {
          totalImpressions += metrics[0].impressions || 0;
          totalLikes += metrics[0].likes || 0;
          totalRetweets += metrics[0].retweets || 0;
          totalReplies += metrics[0].replies || 0;
        }
      }
    }

    // Upsert daily metrics
    const existing = await db.select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.date, targetDate));

    const data = {
      postsCount,
      threadsCount,
      telegramReposts,
      likesGiven,
      retweetsGiven,
      repliesGiven,
      followsGiven,
      totalImpressions,
      totalLikes,
      totalRetweets,
      totalReplies,
    };

    if (existing.length > 0) {
      await db.update(dailyMetrics).set(data).where(eq(dailyMetrics.date, targetDate));
    } else {
      await db.insert(dailyMetrics).values({ date: targetDate, ...data });
    }

    logger.info({ date: targetDate, postsCount, totalImpressions }, 'Daily metrics aggregated');
    return data;
  } catch (err) {
    logger.error({ err, date: targetDate }, 'Failed to aggregate daily metrics');
    throw err;
  }
}

module.exports = { aggregateDaily };
