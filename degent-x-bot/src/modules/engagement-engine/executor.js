const { eq, sql } = require('drizzle-orm');
const { likeTweet, retweet, postTweet } = require('../../services/twitter-client');
const { canExecute, recordUsage } = require('../../lib/rate-limiter');
const { checkSafety } = require('../../lib/content-safety');
const { getDb } = require('../../services/database');
const { engagementLog, trackedAccounts } = require('../../db/schema');
const logger = require('../../lib/logger');

async function executeEngagement(evaluation, tweet, account) {
  const action = evaluation.action;
  const tweetId = tweet.id;

  try {
    switch (action) {
      case 'like': {
        if (!(await canExecute('POST /likes'))) {
          logger.warn('Rate limit reached for likes');
          return false;
        }
        await likeTweet(tweetId);
        await recordUsage('POST /likes');
        break;
      }

      case 'retweet': {
        if (!(await canExecute('POST /retweets'))) {
          logger.warn('Rate limit reached for retweets');
          return false;
        }
        await retweet(tweetId);
        await recordUsage('POST /retweets');
        break;
      }

      case 'reply': {
        if (!(await canExecute('POST /tweets'))) {
          logger.warn('Rate limit reached for tweets');
          return false;
        }
        const replyText = evaluation.reply_text;
        if (!replyText) return false;

        const safety = checkSafety(replyText);
        if (!safety.pass) {
          logger.warn({ failures: safety.failures }, 'Reply failed safety check');
          return false;
        }

        const result = await postTweet(replyText, { replyToTweetId: tweetId });
        await recordUsage('POST /tweets');

        // Log with response tweet id
        await logEngagement(action, tweet, account, evaluation, result.id);
        await updateAccountEngagement(account.id);
        return true;
      }

      case 'quote_tweet': {
        if (!(await canExecute('POST /tweets'))) {
          logger.warn('Rate limit reached for tweets');
          return false;
        }
        const qtText = evaluation.reply_text;
        if (!qtText) return false;

        const safety = checkSafety(qtText);
        if (!safety.pass) {
          logger.warn({ failures: safety.failures }, 'Quote tweet failed safety check');
          return false;
        }

        const result = await postTweet(qtText, { quoteTweetId: tweetId });
        await recordUsage('POST /tweets');

        await logEngagement(action, tweet, account, evaluation, result.id);
        await updateAccountEngagement(account.id);
        return true;
      }

      default:
        return false;
    }

    // Log engagement (for like/retweet)
    await logEngagement(action, tweet, account, evaluation);
    await updateAccountEngagement(account.id);
    return true;
  } catch (err) {
    logger.error({ err, action, tweetId }, 'Failed to execute engagement');
    return false;
  }
}

async function logEngagement(action, tweet, account, evaluation, responseTweetId = null) {
  const db = getDb();
  await db.insert(engagementLog).values({
    actionType: action,
    targetTweetId: tweet.id,
    targetUserId: account.twitterUserId,
    targetUsername: account.username,
    responseText: evaluation.reply_text || null,
    responseTweetId,
    engagementTier: account.tier,
    engagementReason: evaluation.reason,
  });
}

async function updateAccountEngagement(accountId) {
  const db = getDb();
  await db.update(trackedAccounts)
    .set({
      lastEngagedAt: new Date(),
      totalEngagements: sql`total_engagements + 1`,
      updatedAt: new Date(),
    })
    .where(eq(trackedAccounts.id, accountId));
}

module.exports = { executeEngagement };
